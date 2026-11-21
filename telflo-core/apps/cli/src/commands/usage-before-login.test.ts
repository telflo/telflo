import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, type FakeFetch } from "../../tests/fake-fetch.js";
import { runCli } from "../../tests/run-cli.js";
import { deleteCredentials, saveCredentials } from "../credentials.js";

/*
 * The invariant: every command checks its arguments and options (ids,
 * choices, numbers, limits, the files it reads) before it reads the login, so
 * a usage error is exit 2 whether logged in or not, and nothing is sent. One
 * malformed run per command, logged out and logged in.
 */

const SERVER = "https://telflo.example";
const ORGANIZATION = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const ID = "1c8f9bad-2e3f-4a41-9b5c-6d7e8f9a0b1c";

let dir: string;
let fake: FakeFetch;
let token: string;

beforeAll(() => {
  dir = mkdtempSync(join(process.env.HOME!, "usage-"));
  writeFileSync(join(dir, "config.yaml"), "receivers: {}\n");
  writeFileSync(join(dir, "spec.yaml"), "signal: logs\npipeline: logs/in\nsample_text: '{}'\nrules: []\n");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  token = `tf_${randomBytes(32).toString("base64url")}`;
  deleteCredentials();
  fake = fakeFetch(() => ({ status: 500, json: {} }));
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const file = (name: string): string => join(dir, name);

/** One malformed run of each command that takes arguments, as `[label, argv]`. */
const MALFORMED: ReadonlyArray<readonly [string, () => string[]]> = [
  ["config get: a malformed id", () => ["config", "get", "prod"]],
  ["config pull: a malformed id", () => ["config", "pull", "prod", "--version", "2"]],
  ["config pull: --version 0", () => ["config", "pull", ID, "--version", "0"]],
  ["config create: a file that can't be read", () => ["config", "create", "--name", "prod", "-f", file("missing.yaml")]],
  ["config publish: a malformed id", () => ["config", "publish", "prod", "--version", "1"]],
  ["config push: a malformed id", () => ["config", "push", "prod", "-f", file("config.yaml")]],
  ["config push: a file that can't be read", () => ["config", "push", ID, "-f", file("missing.yaml")]],
  ["config push: a label over 80 characters", () => ["config", "push", ID, "-f", file("config.yaml"), "--label", "x".repeat(81)]],
  ["config rules: a malformed id", () => ["config", "rules", "prod"]],
  ["validate: a malformed --config", () => ["validate", file("config.yaml"), "--config", "prod"]],
  ["validate: a file that can't be read", () => ["validate", file("missing.yaml")]],
  ["ottl lint: --expr over the limit", () => ["ottl", "lint", "--context", "log", ...Array.from({ length: 201 }, () => ["--expr", "true"]).flat()]],
  ["ottl lint: an expression too long", () => ["ottl", "lint", "--context", "log", "--expr", "x".repeat(8193)]],
  ["ottl lint: --expr without --context", () => ["ottl", "lint", "--expr", "true"]],
  ["ottl lint: a file that can't be read", () => ["ottl", "lint", file("missing.yaml")]],
  ["flows get: a dot segment", () => ["flows", "get", ".."]],
  ["flows pull: an empty slug", () => ["flows", "pull", ""]],
  ["fleet groups: a malformed id", () => ["fleet", "groups", "edge"]],
  ["fleet create: an unknown type", () => ["fleet", "create", "--label", "edge", "--type", "server-supervisor"]],
  ["fleet install: a flag for another platform", () => ["fleet", "install", ID, "--platform", "docker", "--arch", "arm64"]],
  ["deploy: a malformed --group", () => ["deploy", "--fleet", ID, "--config", ID, "--group", "default"]],
  ["test: a malformed --config", () => ["test", "--spec", file("spec.yaml"), "--config", "prod"]],
  ["test: a -f that can't be read", () => ["test", "--spec", file("spec.yaml"), "-f", file("missing.yaml")]],
  ["test: a spec that can't be read", () => ["test", "--spec", file("missing.yaml"), "-f", file("config.yaml")]],
  ["org use: a malformed id", () => ["org", "use", "acme"]],
  ["login: a malformed --org", () => ["login", "--server", SERVER, "--org", "acme"]],
  ["skills install: --project and --global", () => ["skills", "install", "--project", "--global"]],
];

describe("usage before login", () => {
  it.each(MALFORMED)("%s is exit 2 logged out, nothing sent", async (_label, args) => {
    const result = await runCli(args());
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(fake.calls).toHaveLength(0);
  });

  it.each(MALFORMED)("%s is exit 2 logged in, nothing sent", async (_label, args) => {
    saveCredentials({ version: 1, server: SERVER, token, kind: "person", tokenName: "laptop", organizationId: ORGANIZATION });
    const result = await runCli(args(), { input: token });
    expect(result.stdout.includes(token) || result.stderr.includes(token)).toBe(false);
    expect(result.code).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  it("commander's own usage errors with --json: the one JSON error on stderr, exit 2, nothing sent", async () => {
    for (const args of [
      ["--json", "deploy", "--fleet", ID],
      ["--json", "fleet", "create", "--label", "edge", "--type", "nope"],
      ["--json", "config", "pull"],
      ["--json", "deploy", "--fleet", ID, "--config", ID, "--replicas", "0"],
      ["--json", "frobnicate"],
    ]) {
      const result = await runCli(args);
      expect(result.code).toBe(2);
      const parsed = JSON.parse(result.stderr) as { error: { code: string; message: string; status: null } };
      expect(parsed.error.code).toBe("usage_error");
      expect(parsed.error.status).toBeNull();
      expect(parsed.error.message.startsWith("error:") || parsed.error.message === "").toBe(false);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("the same with --json: the error is the one JSON object on stderr, code usage_error", async () => {
    const result = await runCli(["--json", "config", "get", "prod"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "usage_error", message: "The configuration must be an id (a UUID).", status: null } });
  });
});
