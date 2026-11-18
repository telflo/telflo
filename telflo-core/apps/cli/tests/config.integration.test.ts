import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addConfiguration, addConfigurationVersion, truncateAll } from "@telflo/db/testing";
import { useFakeOtelcolValidator } from "../../api/src/testing/otelcol-validator.js";
import { deleteCredentials } from "../src/credentials.js";
import { PUSH_INVALID_MESSAGE } from "../src/commands/config.js";
import { READ_ONLY_TOKEN_MESSAGE } from "../src/output.js";
import { personWithToken, runCli, serviceAccountWithToken, useApiServer, type CliRun } from "./harness.js";

/*
 * The config commands against the real API in process (D27 decisions 26
 * and 33): create, list (past 100, every page), get, pull, publish and
 * push's two paths (a draft patched with ?validate=true; a published
 * latest validated on its pin, then appended with its label), a 422's
 * errors, an envelope refusal, and a read token on a write (exit 3). The
 * collector validator is the api's OpenAPI-checked fake. Tokens are made
 * at run time and checked with boolean canaries only: what the CLI wrote,
 * and every line the API logged (which holds no YAML either).
 */

const validator = useFakeOtelcolValidator();
const api = useApiServer(() => ({ otelcolValidator: validator.client }));

/** A text no log line may hold. */
const MARKER = "cli-config-marker-5d1e";
const VALID_YAML = `# ${MARKER}\nreceivers:\n  otlp:\nexporters:\n  debug:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n`;
const SECOND_YAML = VALID_YAML.replace("debug", "nop").replace("[debug]", "[nop]");
/** The fake validator refuses a component whose type starts with unknown_. */
const INVALID_YAML = `# ${MARKER}\nreceivers:\n  unknown_thing:\nexporters:\n  debug:\nservice:\n  pipelines:\n    traces:\n      receivers: [unknown_thing]\n      exporters: [debug]\n`;

let tokens: string[];

function holdsAnyToken(...texts: string[]): boolean {
  return texts.some((text) => tokens.some((token) => text.includes(token)));
}

/** Runs the CLI and checks its output holds no token (a boolean) before the test reads it. */
async function cli(args: string[], input?: string): Promise<CliRun> {
  const result = await runCli(args, input === undefined ? {} : { input });
  expect(holdsAnyToken(result.stdout, result.stderr)).toBe(false);
  return result;
}

async function asServiceAccount(access: "read" | "write" = "write"): Promise<{ organizationId: string }> {
  const account = await serviceAccountWithToken(api.ownerDb, access);
  tokens.push(account.token);
  vi.stubEnv("TELFLO_TOKEN", account.token);
  vi.stubEnv("TELFLO_SERVER", api.origin);
  return account;
}

async function created(): Promise<string> {
  const result = await cli(["--json", "config", "create", "--name", "prod", "-f", "-"], VALID_YAML);
  expect(result.code).toBe(0);
  return (JSON.parse(result.stdout) as { id: string }).id;
}

beforeEach(async () => {
  await truncateAll(api.ownerDb);
  deleteCredentials();
  tokens = [];
  api.logLines.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  expect(holdsAnyToken(...api.logLines)).toBe(false);
  expect(api.logLines.some((line) => line.includes(MARKER))).toBe(false);
  expect(validator.fake.takeViolations()).toEqual([]);
});

describe("config create, get, pull and publish", () => {
  it("creates a configuration with its draft v1, reads it back, pulls it and publishes it", async () => {
    await asServiceAccount();
    const id = await created();

    const get = await cli(["--json", "config", "get", id]);
    expect(get.code).toBe(0);
    const detail = JSON.parse(get.stdout) as {
      name: string;
      isPublished: boolean;
      versionNumber: number;
      publishedVersionNumber: number | null;
      versions: Array<{ versionNumber: number; status: string }>;
    };
    expect(detail).toMatchObject({ name: "prod", isPublished: false, versionNumber: 1, publishedVersionNumber: null });
    expect(detail.versions.map((version) => [version.versionNumber, version.status])).toEqual([[1, "draft"]]);

    const pull = await cli(["config", "pull", id]);
    expect(pull.code).toBe(0);
    expect(pull.stdout).toBe(VALID_YAML);
    expect(pull.stderr.startsWith("# v1, pinned to ")).toBe(true);

    const publish = await cli(["config", "publish", id, "--version", "1"]);
    expect(publish.code).toBe(0);
    expect(publish.stdout).toBe(`Published v1 of "prod" (${id}).\n`);
    expect(JSON.parse((await cli(["--json", "config", "get", id])).stdout)).toMatchObject({ isPublished: true, publishedVersionNumber: 1 });
  });

  it("answers an envelope refusal in its words (exit 1), and a read token's write is exit 3", async () => {
    await asServiceAccount("read");
    const missing = await cli(["--json", "config", "get", "6f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({ error: { code: "configuration_not_found", status: 404 } });

    const write = await cli(["config", "create", "--name", "prod", "-f", "-"], VALID_YAML);
    expect(write.code).toBe(3);
    expect(write.stderr).toBe(`error: ${READ_ONLY_TOKEN_MESSAGE}\n`);
    expect(JSON.parse((await cli(["--json", "config", "list"])).stdout)).toEqual([]);
  });
});

describe("config list", () => {
  it("follows every page past 100 for a person's token, in its organization", async () => {
    const person = await personWithToken(api.ownerDb);
    tokens.push(person.token);
    for (let index = 0; index < 101; index += 1) {
      const configuration = await addConfiguration(api.ownerDb, {
        organizationId: person.organizationId,
        created_by_user_id: person.userId,
      });
      await addConfigurationVersion(api.ownerDb, { configurationId: configuration.id, organizationId: person.organizationId });
    }
    vi.stubEnv("TELFLO_TOKEN", person.token);
    vi.stubEnv("TELFLO_SERVER", api.origin);
    vi.stubEnv("TELFLO_ORG", person.organizationId);
    const list = await cli(["--json", "config", "list"]);
    expect(list.code).toBe(0);
    const items = JSON.parse(list.stdout) as Array<{ id: string; organizationId: string }>;
    expect(items).toHaveLength(101);
    expect(new Set(items.map((item) => item.id)).size).toBe(101);
    expect(items.every((item) => item.organizationId === person.organizationId)).toBe(true);
    const human = await cli(["config", "list"]);
    expect(human.stdout.trimEnd().split("\n")).toHaveLength(103);
  });
});

describe("config push", () => {
  it("patches a draft latest in place, validated; a 422's errors are printed (exit 4) and nothing is saved", async () => {
    await asServiceAccount();
    const id = await created();

    const push = await cli(["config", "push", id, "-f", "-"], SECOND_YAML);
    expect(push.code).toBe(0);
    expect(push.stdout).toBe(`Updated draft v1. Publish it with: telflo config publish ${id} --version 1\n`);
    expect((await cli(["config", "pull", id])).stdout).toBe(SECOND_YAML);

    const invalid = await cli(["config", "push", id, "-f", "-", "--publish"], INVALID_YAML);
    expect(invalid.code).toBe(4);
    expect(invalid.stdout.startsWith("Invalid:\n  - ")).toBe(true);
    expect(invalid.stdout.includes("unknown_thing")).toBe(true);
    expect(invalid.stderr).toBe(`error: ${PUSH_INVALID_MESSAGE}\n`);
    expect((await cli(["config", "pull", id])).stdout).toBe(SECOND_YAML);
    expect(JSON.parse((await cli(["--json", "config", "get", id])).stdout)).toMatchObject({ isPublished: false });
  });

  it("validates on a published latest's pin, then appends the version with its label, and publishes it with --publish", async () => {
    await asServiceAccount();
    const id = await created();
    expect((await cli(["config", "publish", id, "--version", "1"])).code).toBe(0);
    const pin = JSON.parse((await cli(["--json", "config", "get", id])).stdout) as { distribution: string; collectorVersion: string };

    validator.fake.takeRequests();
    const invalid = await cli(["--json", "config", "push", id, "-f", "-"], INVALID_YAML);
    expect(invalid.code).toBe(4);
    expect((JSON.parse(invalid.stdout) as { status: string; errors: unknown[] }).errors.length > 0).toBe(true);
    expect(JSON.parse((await cli(["--json", "config", "get", id])).stdout)).toMatchObject({ versionNumber: 1 });
    const checked = validator.fake.takeRequests();
    expect(checked.map((request) => [request.distribution, request.version])).toEqual([[pin.distribution, pin.collectorVersion]]);

    const push = await cli(["--json", "config", "push", id, "-f", "-", "--description", "tighter batching", "--publish"], SECOND_YAML);
    expect(push.code).toBe(0);
    expect(JSON.parse(push.stdout)).toEqual({ action: "appended", versionNumber: 2, published: true });
    const detail = JSON.parse((await cli(["--json", "config", "get", id])).stdout) as {
      publishedVersionNumber: number;
      versions: Array<{ versionNumber: number; status: string; label: string | null }>;
    };
    expect(detail.publishedVersionNumber).toBe(2);
    expect(detail.versions[0]).toMatchObject({ versionNumber: 2, status: "published", label: "tighter batching" });
    expect((await cli(["config", "pull", id, "--version", "2"])).stdout).toBe(SECOND_YAML);
  });
});
