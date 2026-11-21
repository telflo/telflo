import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envelope, routedFetch, type FakeFetch } from "../../tests/fake-fetch.js";
import { runCli, type CliRun } from "../../tests/run-cli.js";
import { deleteCredentials, saveCredentials } from "../credentials.js";
import { describeRule, NO_PIPELINES_MESSAGE } from "./config-rules.js";

/* telflo config rules (route 13). */

const SERVER = "https://telflo.example";
const ORGANIZATION = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const CONFIGURATION = "1c8f9bad-2e3f-4a41-9b5c-6d7e8f9a0b1c";

function rule(position: number, fields: Record<string, unknown>) {
  return {
    id: `0000000${position}-0000-4000-8000-000000000000`,
    validationPipelineId: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
    position,
    kind: "ottl",
    target: "output",
    pattern: null,
    ottl: null,
    name: "",
    description: "",
    createdByUserId: null,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    isApiOwned: true,
    ...fields,
  };
}

const PIPELINE = {
  id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
  configurationId: CONFIGURATION,
  versionId: "8c7b6a5f-4e3d-4c2b-9a1f-0e9d8c7b6a5f",
  versionNumber: 3,
  pipeline: "logs/in",
  signal: "logs",
  createdByUserId: null,
  createdAt: "2026-10-26T00:00:00.000Z",
  rules: [
    rule(1, { name: "total", ottl: { context: "log", quantifier: "count", condition: "true", count: { operator: "gte", value: 1 } } }),
    rule(2, { kind: "contains_text", pattern: "hello\nworld", isApiOwned: false, name: "a person's" }),
  ],
};

let token: string;
let fake: FakeFetch;


/** `telflo …` in process, its output checked for the token (a boolean) before any test reads it. */
async function cli(args: readonly string[], options?: Parameters<typeof runCli>[1]): Promise<CliRun> {
  const ran = await runCli(args, options);
  expect([ran.stdout, ran.stderr].some((text) => text.includes(token))).toBe(false);
  return ran;
}

beforeEach(() => {
  token = `tf_${randomBytes(32).toString("base64url")}`;
  deleteCredentials();
  saveCredentials({ version: 1, server: SERVER, token, kind: "person", tokenName: "laptop", organizationId: ORGANIZATION });
  fake = routedFetch({
    [`GET /configurations/${CONFIGURATION}`]: { json: { id: CONFIGURATION, versionNumber: 3 } },
    [`GET /configurations/${CONFIGURATION}/versions/3/validation-pipelines`]: { json: { items: [PIPELINE], nextCursor: null } },
    [`GET /configurations/${CONFIGURATION}/versions/2/validation-pipelines`]: { json: { items: [], nextCursor: null } },
    [`GET /configurations/${CONFIGURATION}/versions/9/validation-pipelines`]: {
      status: 404,
      json: envelope("configuration_version_not_found", "No such version."),
    },
  });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telflo config rules", () => {
  it("shows the latest version's pipelines and their rules, the id canonicalized", async () => {
    const result = await cli(["config", "rules", CONFIGURATION.toUpperCase()]);
    expect(result.code).toBe(0);
    expect(fake.calls.map((call) => call.url.pathname)).toEqual([
      `/api/public/v1/configurations/${CONFIGURATION}`,
      `/api/public/v1/configurations/${CONFIGURATION}/versions/3/validation-pipelines`,
    ]);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe("logs/in (logs): 2 rules, 1 API-owned");
    expect(lines[1]?.split(/\s+/)).toEqual(["#", "name", "kind", "target", "api", "rule"]);
    expect(lines[3]?.split(/\s{2,}/)).toEqual(["1", "total", "ottl", "output", "yes", "log count true gte 1"]);
    expect(lines[4]?.split(/\s{2,}/)).toEqual(["2", "a person's", "contains_text", "output", "hello world"]);
    expect(result.stdout.includes(token)).toBe(false);
  });

  it("--version names the version without route 5; none saved says so; --json is the list", async () => {
    const none = await cli(["config", "rules", CONFIGURATION, "--version", "2"]);
    expect(none.stdout).toBe(`${NO_PIPELINES_MESSAGE(2)}\n`);
    expect(fake.calls).toHaveLength(1);
    const json = await cli(["--json", "config", "rules", CONFIGURATION, "--version", "3"]);
    expect(JSON.parse(json.stdout)).toEqual({ configurationId: CONFIGURATION, versionNumber: 3, items: [PIPELINE] });
  });

  it("a malformed id or version is exit 2 before any request; an unknown version is the API's 404 (exit 1); no login exit 3", async () => {
    expect((await cli(["config", "rules", "acme"])).code).toBe(2);
    expect((await cli(["config", "rules", CONFIGURATION, "--version", "0"])).code).toBe(2);
    expect(fake.calls).toHaveLength(0);
    const missing = await cli(["config", "rules", CONFIGURATION, "--version", "9"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe("error: No such version.\n");
    deleteCredentials();
    expect((await cli(["config", "rules", CONFIGURATION])).code).toBe(3);
  });
});

describe("terminal text", () => {
  it("strips control characters from every server string it prints", async () => {
    const escape = "\u001b]0;title\u0007\u009b2J";
    const hostile = {
      ...PIPELINE,
      pipeline: `logs/in${escape}`,
      rules: [rule(1, { name: `n${escape}`, kind: `ottl${escape}`, ottl: { context: "log", quantifier: "any", condition: `c${escape}` } })],
    };
    fake = routedFetch({ [`GET /configurations/${CONFIGURATION}/versions/3/validation-pipelines`]: { json: { items: [hostile], nextCursor: null } } });
    vi.stubGlobal("fetch", fake.fetch);
    const result = await cli(["config", "rules", CONFIGURATION, "--version", "3"]);
    expect(result.code).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(result.stdout)).toBe(false);
  });
});

describe("describeRule", () => {
  it("an OTTL rule's context, quantifier, texts and count; a pattern rule's pattern", () => {
    expect(describeRule({ kind: "ottl", pattern: null, ottl: { context: "log", quantifier: "any", condition: "body != nil" } })).toBe("log any body != nil");
    expect(
      describeRule({
        kind: "ottl",
        pattern: null,
        ottl: { context: "span", quantifier: "distinct", expression: "name", condition: "kind == 2", count: { operator: "between", value: 1, value2: 4 } },
      }),
    ).toBe("span distinct name where kind == 2 between 1..4");
    expect(describeRule({ kind: "contains_regex", pattern: "a\tb", ottl: null })).toBe("a b");
  });
});
