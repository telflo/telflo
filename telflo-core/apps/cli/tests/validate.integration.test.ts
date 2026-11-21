import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { truncateAll } from "@telflo/db/testing";
import { useFakeOtelcolValidator } from "../../api/src/testing/otelcol-validator.js";
import { deleteCredentials } from "../src/credentials.js";
import { CONFIG_NEEDS_LOGIN_MESSAGE, VALIDATION_FAILED_MESSAGE } from "../src/commands/validate.js";
import { runCli, serviceAccountWithToken, useApiServer, type CliRun } from "./harness.js";

/*
 * telflo validate against the real API in process: logged in on route 15,
 * logged out on the anonymous route (no token sent), --config's pin, an
 * invalid text (exit 4), an unknown version (a 400: exit 2) and --config
 * without a login (exit 3). The collector validator is the api's
 * OpenAPI-checked fake. Tokens are made at run time and checked with boolean
 * canaries only; no log line holds the text.
 */

const validator = useFakeOtelcolValidator();
const api = useApiServer(() => ({ otelcolValidator: validator.client }));

const MARKER = "cli-validate-marker-7b2c";
const VALID_YAML = `# ${MARKER}\nreceivers:\n  otlp:\nexporters:\n  debug:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n`;
const INVALID_YAML = VALID_YAML.replace(/otlp/g, "unknown_thing");

let tokens: string[];

function holdsAnyToken(...texts: string[]): boolean {
  return texts.some((text) => tokens.some((token) => text.includes(token)));
}

async function cli(args: string[], input?: string): Promise<CliRun> {
  const result = await runCli(args, input === undefined ? {} : { input });
  expect(holdsAnyToken(result.stdout, result.stderr)).toBe(false);
  return result;
}

async function loggedIn(): Promise<void> {
  const account = await serviceAccountWithToken(api.ownerDb, "read");
  tokens.push(account.token);
  vi.stubEnv("TELFLO_TOKEN", account.token);
  vi.stubEnv("TELFLO_SERVER", api.origin);
}

beforeEach(async () => {
  await truncateAll(api.ownerDb);
  deleteCredentials();
  tokens = [];
  api.logLines.length = 0;
  validator.fake.takeRequests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  expect(holdsAnyToken(...api.logLines)).toBe(false);
  expect(api.logLines.some((line) => line.includes(MARKER))).toBe(false);
  expect(validator.fake.takeViolations()).toEqual([]);
});

describe("telflo validate, logged in", () => {
  it("validates on route 15 with a read token: valid exits 0, invalid prints the errors and exits 4", async () => {
    await loggedIn();
    const valid = await cli(["validate", "-"], VALID_YAML);
    expect(valid.code).toBe(0);
    expect(valid.stdout.startsWith("Valid (collector ")).toBe(true);
    const invalid = await cli(["validate", "-"], INVALID_YAML);
    expect(invalid.code).toBe(4);
    expect(invalid.stdout.includes("unknown_thing")).toBe(true);
    expect(invalid.stderr).toBe(`error: ${VALIDATION_FAILED_MESSAGE}\n`);
    expect(api.logLines.some((line) => line.includes("/api/public/v1/validate") && !line.includes("anonymous"))).toBe(true);
  });

  it("validates on a stored configuration's pin with --config", async () => {
    const account = await serviceAccountWithToken(api.ownerDb, "write");
    tokens.push(account.token);
    vi.stubEnv("TELFLO_TOKEN", account.token);
    vi.stubEnv("TELFLO_SERVER", api.origin);
    const created = JSON.parse((await cli(["--json", "config", "create", "--name", "pinned", "-f", "-"], VALID_YAML)).stdout) as {
      id: string;
      distribution: string;
      collectorVersion: string;
    };
    validator.fake.takeRequests();
    const result = await cli(["validate", "-", "--config", created.id], VALID_YAML);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(`# validating on ${created.distribution} ${created.collectorVersion} (from configuration ${created.id})\n`);
    expect(validator.fake.takeRequests().map((request) => [request.distribution, request.version])).toEqual([
      [created.distribution, created.collectorVersion],
    ]);
  });

  it("is exit 2 for a version the catalog doesn't have, the validator never asked", async () => {
    await loggedIn();
    const result = await cli(["--json", "validate", "-", "--collector-version", "0.0.1"], VALID_YAML);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "collector_version_unknown" } });
    expect(validator.fake.takeRequests()).toEqual([]);
  });
});

describe("telflo validate, not logged in (the anonymous route)", () => {
  it("validates with no login on /validate/anonymous: valid 0, invalid 4", async () => {
    vi.stubEnv("TELFLO_SERVER", api.origin);
    const valid = await cli(["validate", "-"], VALID_YAML);
    expect(valid.code).toBe(0);
    expect(valid.stdout.startsWith("Valid (collector ")).toBe(true);
    const invalid = await cli(["--json", "validate", "-"], INVALID_YAML);
    expect(invalid.code).toBe(4);
    expect((JSON.parse(invalid.stdout) as { valid: boolean }).valid).toBe(false);
    expect(validator.fake.takeRequests().every((request) => request.organizationVariables === undefined)).toBe(true);
    expect(api.logLines.some((line) => line.includes("/api/public/v1/validate/anonymous"))).toBe(true);
  });

  it("refuses --config without a login (exit 3), nothing sent", async () => {
    vi.stubEnv("TELFLO_SERVER", api.origin);
    const result = await cli(["validate", "-", "--config", "6f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f"], VALID_YAML);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe(`error: ${CONFIG_NEEDS_LOGIN_MESSAGE}\n`);
    expect(api.logLines.some((line) => line.includes("/api/public/v1/"))).toBe(false);
  });
});
