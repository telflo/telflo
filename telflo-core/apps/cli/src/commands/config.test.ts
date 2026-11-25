import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH, PublicCreateConfigurationVersionRequestSchema } from "@telflo/contracts";
import { envelope, routedFetch, type Answer, type FakeFetch, type RecordedCall } from "../../tests/fake-fetch.js";
import { runCli, type CliRun } from "../../tests/run-cli.js";
import { deleteCredentials, saveCredentials, type TokenKind } from "../credentials.js";
import { PUSH_CHANGED_MESSAGE, PUSH_NOT_PUBLISHED_MESSAGE } from "../ops/configurations.js";
import { READ_ONLY_TOKEN_MESSAGE } from "../output.js";
import {
  CANNOT_WRITE_MESSAGE,
  LABEL_AND_DESCRIPTION_MESSAGE,
  LABEL_LENGTH_MESSAGE,
  LABEL_MAXIMUM_LENGTH,
  LABEL_NOT_APPLIED_NOTE,
  NO_CONFIGURATIONS_MESSAGE,
  PUSH_INVALID_MESSAGE,
} from "./config.js";

/*
 * The config commands against a stand-in API: each command's requests (paths,
 * queries, bodies) and its output, human and --json. Tokens are made at run
 * time; what the CLI wrote is checked for them with boolean canaries only.
 */

const SERVER = "https://telflo.example";
const ORGANIZATION = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const ID = "1c8f9bad-2e3f-4a41-9b5c-6d7e8f9a0b1c";
const OTHER = "2d9a0cbe-3f4a-4b52-8c6d-7e8f9a0b1c2d";
const YAML = "receivers:\n  otlp: {}\n";
const AT = "2026-10-26T12:00:00.000Z";

function configuration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    name: "prod",
    description: "",
    organizationId: ORGANIZATION,
    isPublished: true,
    distribution: "otelcol-contrib",
    collectorVersion: "0.147.0",
    versionNumber: 3,
    publishedVersionNumber: 2,
    updatedAt: AT,
    ...overrides,
  };
}

function version(versionNumber: number, status: "draft" | "published", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: versionId(versionNumber),
    versionNumber,
    status,
    label: null,
    distribution: "otelcol-contrib",
    collectorVersion: "0.147.0",
    createdAt: AT,
    publishedAt: status === "published" ? AT : null,
    ...overrides,
  };
}

function versionId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

let token: string;

/** Whether a text holds a control character but the newline. */
function holdsControl(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text);
}

/** Runs the CLI; its output is checked for the token (a boolean) before any test reads it. */
async function cli(...args: Parameters<typeof runCli>): Promise<CliRun> {
  const result = await runCli(...args);
  expect(result.stdout.includes(token) || result.stderr.includes(token)).toBe(false);
  return result;
}
let fake: FakeFetch;
let file: string;

function routes(table: Record<string, Answer | ((call: RecordedCall) => Answer)>): FakeFetch {
  fake = routedFetch(table);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

function store(kind: TokenKind = "service_account"): void {
  saveCredentials({ version: 1, server: SERVER, token, kind, tokenName: "ci", organizationId: ORGANIZATION });
}

function holdsToken(...texts: string[]): boolean {
  return texts.some((text) => text.includes(token));
}

function bodyOf(call: RecordedCall | undefined): unknown {
  return call?.body === undefined ? undefined : JSON.parse(call.body);
}

function requests(): string[] {
  return fake.calls.map((call) => `${call.method} ${call.url.pathname.replace("/api/public/v1", "")}${call.url.search}`);
}

beforeEach(() => {
  token = `tf_${randomBytes(32).toString("base64url")}`;
  deleteCredentials();
  store();
  file = join(process.env.HOME!, `config-${randomBytes(4).toString("hex")}.yaml`);
  writeFileSync(file, YAML);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("telflo config list", () => {
  it("follows every page (limit 100, the cursor) and prints the table", async () => {
    routes({
      "GET /configurations": (call) =>
        call.url.searchParams.get("cursor") === null
          ? { json: { items: [configuration()], nextCursor: "next-page" } }
          : { json: { items: [configuration({ id: OTHER, name: "draft", publishedVersionNumber: null, versionNumber: 1 })], nextCursor: null } },
    });
    const result = await cli(["config", "list"]);
    expect(result.code).toBe(0);
    expect(requests()).toEqual(["GET /configurations?limit=100", "GET /configurations?limit=100&cursor=next-page"]);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toMatch(/^id\s+name\s+published\s+latest\s+collector$/);
    expect(lines[2]).toMatch(new RegExp(`^${ID}\\s+prod\\s+v2\\s+v3\\s+otelcol-contrib 0\\.147\\.0$`));
    expect(lines[3]).toMatch(new RegExp(`^${OTHER}\\s+draft\\s+-\\s+v1\\s+otelcol-contrib 0\\.147\\.0$`));
    expect(holdsToken(result.stdout, result.stderr)).toBe(false);
  });

  it("prints the items as JSON with --json, and says so when there are none", async () => {
    routes({ "GET /configurations": { json: { items: [configuration()], nextCursor: null } } });
    expect(JSON.parse((await cli(["--json", "config", "list"])).stdout)).toEqual([configuration()]);
    routes({ "GET /configurations": { json: { items: [], nextCursor: null } } });
    expect((await cli(["config", "list"])).stdout).toBe(`${NO_CONFIGURATIONS_MESSAGE}\n`);
  });

  it("exits 3 when not logged in, before any request", async () => {
    deleteCredentials();
    routes({});
    expect((await cli(["config", "list"])).code).toBe(3);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("telflo config get", () => {
  it("reads the configuration and its versions, the id canonicalized", async () => {
    routes({
      [`GET /configurations/${ID}`]: { json: { ...configuration(), yaml: YAML } },
      [`GET /configurations/${ID}/versions`]: {
        json: { items: [version(3, "draft"), version(2, "published", { label: "tighter batching" })], nextCursor: null },
      },
    });
    const result = await cli(["config", "get", ID.toUpperCase()]);
    expect(result.code).toBe(0);
    expect(requests()).toEqual([`GET /configurations/${ID}`, `GET /configurations/${ID}/versions`]);
    const lines = result.stdout.split("\n");
    expect(lines.slice(0, 3)).toEqual([`prod (${ID})`, "published: v2", "collector: otelcol-contrib 0.147.0 (v3's pin)"]);
    expect(lines[4]).toMatch(/^version\s+status\s+label\s+collector\s+created$/);
    expect(lines[6]).toMatch(/^v3\s+draft\s+otelcol-contrib 0\.147\.0\s+2026-10-26T12:00:00\.000Z$/);
    expect(lines[7]).toMatch(/^v2\s+published\s+tighter batching\s+otelcol-contrib/);
  });

  it("says 'no' for a draft, and prints the configuration with its versions as JSON", async () => {
    const draft = { ...configuration({ isPublished: false, publishedVersionNumber: null }), yaml: YAML };
    routes({
      [`GET /configurations/${ID}`]: { json: draft },
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(1, "draft")], nextCursor: null } },
    });
    expect((await cli(["config", "get", ID])).stdout.split("\n")[1]).toBe("published: no");
    expect(JSON.parse((await cli(["--json", "config", "get", ID])).stdout)).toEqual({ ...draft, versions: [version(1, "draft")] });
  });

  it("refuses a malformed id before any request (exit 2), and shows a 404's words (exit 1)", async () => {
    routes({});
    const malformed = await cli(["config", "get", "prod"]);
    expect(malformed.code).toBe(2);
    expect(malformed.stderr).toBe("error: The configuration must be an id (a UUID).\n");
    expect(fake.calls).toHaveLength(0);
    routes({ [`GET /configurations/${ID}`]: { status: 404, json: envelope("configuration_not_found", "Configuration not found.") } });
    const missing = await cli(["config", "get", ID]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe("error: Configuration not found.\n");
  });
});

describe("server strings in human lines", () => {
  const ESCAPE = "\u001b]0;owned\u0007\u009b2J";

  it("strips control characters from a name, a pin and the validator's errors; pull keeps the YAML byte for byte", async () => {
    const named = { ...configuration({ name: `prod${ESCAPE}`, distribution: `otelcol${ESCAPE}` }), yaml: `a: "\t${ESCAPE}"\n` };
    routes({
      [`GET /configurations/${ID}`]: { json: named },
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(3, "draft", { label: `l${ESCAPE}` })], nextCursor: null } },
      "POST /configurations": { status: 201, json: named },
      [`POST /configurations/${ID}/versions/3/publish`]: { json: named },
    });
    const outputs = [
      (await cli(["config", "get", ID])).stdout,
      (await cli(["config", "create", "--name", "prod", "-f", file])).stdout,
      (await cli(["config", "publish", ID, "--version", "3"])).stdout,
    ];
    const pull = await cli(["config", "pull", ID]);
    outputs.push(pull.stderr);
    for (const output of outputs) expect(holdsControl(output)).toBe(false);
    expect(outputs[0]?.startsWith(`prod]0;owned2J (${ID})\n`)).toBe(true);
    expect(pull.stdout === named.yaml).toBe(true);

    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(3, "published")], nextCursor: null } },
      "POST /validate": { json: { valid: false, collectorVersion: "0.147.0", errors: [{ message: `bad${ESCAPE}`, componentPath: `p${ESCAPE}` }] } },
    });
    const push = await cli(["config", "push", ID, "-f", file]);
    expect(push.stdout).toBe("Invalid:\n  - bad]0;owned2J (p]0;owned2J)\n");
  });
});

describe("telflo config pull", () => {
  // Another member's stored YAML may hold escape sequences: concealed text, an OSC 8 link, an OSC 52 clipboard write.
  const STORED_WITH_ESCAPES = "receivers: {}\n# \u001b[8mhidden\u001b[0m \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 \u001b]52;c;Y3VybCBldmlsfHNo\u0007\nexporters:\n\tdebug: {}\n";

  it("prints stored YAML to a terminal without its control characters, its newlines and tabs kept", async () => {
    routes({ [`GET /configurations/${ID}`]: { json: { ...configuration(), yaml: STORED_WITH_ESCAPES } } });
    const result = await cli(["config", "pull", ID], { stdoutTty: true });
    expect(result.code).toBe(0);
    expect(holdsControl(result.stdout.replaceAll("\t", ""))).toBe(false);
    expect(result.stdout).toBe("receivers: {}\n# [8mhidden[0m ]8;;https://evil.examplelink]8;; ]52;c;Y3VybCBldmlsfHNo\nexporters:\n\tdebug: {}\n");
  });

  it("pipes stored YAML byte for byte (a file it is redirected to is the version as saved)", async () => {
    routes({ [`GET /configurations/${ID}`]: { json: { ...configuration(), yaml: STORED_WITH_ESCAPES } } });
    const result = await cli(["config", "pull", ID]);
    expect(result.stdout).toBe(STORED_WITH_ESCAPES);
  });

  it("prints the latest version's YAML exactly, its pin on stderr", async () => {
    routes({ [`GET /configurations/${ID}`]: { json: { ...configuration(), yaml: "receivers: {}" } } });
    const result = await cli(["config", "pull", ID]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("receivers: {}");
    expect(result.stderr).toBe("# v3, pinned to otelcol-contrib 0.147.0\n");
  });

  it("reads one version with --version (route 10), its own pin", async () => {
    routes({
      [`GET /configurations/${ID}/versions/2`]: {
        json: { ...version(2, "published", { collectorVersion: "0.146.0" }), configurationId: ID, yaml: YAML },
      },
    });
    const result = await cli(["--json", "config", "pull", ID, "--version", "2"]);
    expect(requests()).toEqual([`GET /configurations/${ID}/versions/2`]);
    expect(JSON.parse(result.stdout)).toEqual({
      id: ID,
      versionNumber: 2,
      yaml: YAML,
      distribution: "otelcol-contrib",
      collectorVersion: "0.146.0",
    });
  });

  it("writes the YAML to a file with -o and says where, with the pin", async () => {
    routes({ [`GET /configurations/${ID}`]: { json: { ...configuration(), yaml: YAML } } });
    const out = join(process.env.HOME!, "pulled.yaml");
    const result = await cli(["config", "pull", ID, "-o", out]);
    expect(result.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(YAML);
    expect(result.stdout).toBe(
      `Wrote v3 to ${out} (pinned to otelcol-contrib 0.147.0). Validate or test it on that collector with --config ${ID}.\n`,
    );
    const json = await cli(["--json", "config", "pull", ID, "-o", out]);
    expect(JSON.parse(json.stdout)).toEqual({ id: ID, versionNumber: 3, out, distribution: "otelcol-contrib", collectorVersion: "0.147.0" });
  });

  it("refuses a file it can't write (exit 2) and a version that isn't a plain positive integer (exit 2, no request)", async () => {
    routes({ [`GET /configurations/${ID}`]: { json: { ...configuration(), yaml: YAML } } });
    const out = join(process.env.HOME!, "no-such-folder", "pulled.yaml");
    const unwritable = await cli(["config", "pull", ID, "-o", out]);
    expect(unwritable.code).toBe(2);
    expect(unwritable.stderr).toBe(`error: ${CANNOT_WRITE_MESSAGE(out)}\n`);
    routes({});
    for (const bad of ["0", "07", "-1", "1e2", "two", "1000000000"]) {
      expect((await cli(["config", "pull", ID, "--version", bad])).code).toBe(2);
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe("telflo config create", () => {
  it("posts the name and the file's YAML, and says how to publish", async () => {
    routes({ "POST /configurations": { status: 201, json: { ...configuration({ versionNumber: 1 }), yaml: YAML } } });
    const result = await cli(["config", "create", "--name", "prod", "-f", file]);
    expect(result.code).toBe(0);
    expect(bodyOf(fake.calls[0])).toEqual({ name: "prod", yaml: YAML });
    expect(result.stdout).toBe(
      `Created configuration "prod" (${ID}) with draft v1. Publish it with: telflo config publish ${ID} --version 1\n`,
    );
    expect(holdsToken(result.stdout, result.stderr)).toBe(false);
  });

  it("reads stdin for -, and prints the reply as JSON", async () => {
    const created = { ...configuration({ versionNumber: 1 }), yaml: "from: stdin\n" };
    routes({ "POST /configurations": { status: 201, json: created } });
    const result = await cli(["--json", "config", "create", "--name", "prod", "-f", "-"], { input: "from: stdin\n" });
    expect(bodyOf(fake.calls[0])).toEqual({ name: "prod", yaml: "from: stdin\n" });
    expect(JSON.parse(result.stdout)).toEqual(created);
  });

  it("a read token's 403 is exit 3, the token named read-only; a missing file is exit 2 with no request", async () => {
    routes({ "POST /configurations": { status: 403, json: envelope("insufficient_access", "This token can't do that.") } });
    const refused = await cli(["config", "create", "--name", "prod", "-f", file]);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toBe(`error: ${READ_ONLY_TOKEN_MESSAGE}\n`);
    routes({});
    expect((await cli(["config", "create", "--name", "prod", "-f", join(process.env.HOME!, "missing.yaml")])).code).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("telflo config publish", () => {
  it("publishes the version and says so", async () => {
    routes({ [`POST /configurations/${ID}/versions/3/publish`]: { json: { ...configuration(), yaml: YAML } } });
    const result = await cli(["config", "publish", ID, "--version", "3"]);
    expect(result.code).toBe(0);
    expect(fake.calls[0]?.body).toBeUndefined();
    expect(result.stdout).toBe(`Published v3 of "prod" (${ID}).\n`);
    expect(JSON.parse((await cli(["--json", "config", "publish", ID, "--version", "3"])).stdout)).toMatchObject({ id: ID });
  });

  it("needs --version (exit 2)", async () => {
    routes({});
    expect((await cli(["config", "publish", ID])).code).toBe(2);
  });
});

describe("telflo config push", () => {
  const patched = (call: RecordedCall): Answer => ({
    json: { ...version(4, "draft"), configurationId: ID, yaml: (bodyOf(call) as { yaml: string }).yaml },
  });

  it("patches a draft latest with ?validate=true and the file's YAML", async () => {
    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft"), version(3, "published")], nextCursor: null } },
      [`PATCH /configurations/${ID}/versions/4`]: patched,
    });
    const result = await cli(["config", "push", ID, "-f", file]);
    expect(result.code).toBe(0);
    expect(requests()).toEqual([`GET /configurations/${ID}/versions`, `PATCH /configurations/${ID}/versions/4?validate=true`]);
    expect(bodyOf(fake.calls[1])).toEqual({ yaml: YAML });
    expect(result.stdout).toBe(`Updated draft v4. Publish it with: telflo config publish ${ID} --version 4\n`);
    expect(result.stderr).toBe("");
  });

  it("validates on a published latest's pin, then appends the version with its label, and publishes with --publish", async () => {
    routes({
      [`GET /configurations/${ID}/versions`]: {
        json: { items: [version(2, "published"), version(3, "published", { distribution: "otelcol-k8s", collectorVersion: "0.146.0" })], nextCursor: null },
      },
      "POST /validate": { json: { valid: true, collectorVersion: "0.146.0", errors: [] } },
      [`POST /configurations/${ID}/versions`]: { status: 201, json: { ...version(4, "draft"), configurationId: ID, yaml: YAML } },
      [`POST /configurations/${ID}/versions/4/publish`]: { json: { ...configuration(), yaml: YAML } },
    });
    const result = await cli(["config", "push", ID, "-f", file, "--label", "tighter batching", "--publish"]);
    expect(result.code).toBe(0);
    expect(requests()).toEqual([
      `GET /configurations/${ID}/versions`,
      "POST /validate",
      `POST /configurations/${ID}/versions`,
      `POST /configurations/${ID}/versions/4/publish`,
    ]);
    expect(bodyOf(fake.calls[1])).toEqual({ yaml: YAML, distribution: "otelcol-k8s", collectorVersion: "0.146.0" });
    expect(bodyOf(fake.calls[2])).toEqual({ yaml: YAML, label: "tighter batching" });
    expect(result.stdout).toBe("Created v4 and published it.\n");
  });

  it("takes --description as --label's alias, refuses both, and sends no label without one", async () => {
    const table = {
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(3, "published")], nextCursor: null } },
      "POST /validate": { json: { valid: true, collectorVersion: "0.147.0", errors: [] } },
      [`POST /configurations/${ID}/versions`]: { status: 201, json: { ...version(4, "draft"), configurationId: ID, yaml: YAML } },
    };
    routes(table);
    await cli(["config", "push", ID, "-f", file, "--description", "old name"]);
    expect(bodyOf(fake.calls[2])).toEqual({ yaml: YAML, label: "old name" });
    routes(table);
    const json = await cli(["--json", "config", "push", ID, "-f", file]);
    expect(bodyOf(fake.calls[2])).toEqual({ yaml: YAML });
    expect(JSON.parse(json.stdout)).toEqual({ action: "appended", versionNumber: 4, published: false });
    routes(table);
    const both = await cli(["config", "push", ID, "-f", file, "--label", "a", "--description", "b"]);
    expect(both.code).toBe(2);
    expect(both.stderr).toBe(`error: ${LABEL_AND_DESCRIPTION_MESSAGE}\n`);
    expect(fake.calls).toHaveLength(0);
  });

  it("says a label wasn't applied when the draft was patched in place", async () => {
    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft")], nextCursor: null } },
      [`PATCH /configurations/${ID}/versions/4`]: patched,
    });
    const result = await cli(["config", "push", ID, "-f", file, "--label", "ignored"]);
    expect(result.code).toBe(0);
    expect(bodyOf(fake.calls[1])).toEqual({ yaml: YAML });
    expect(result.stderr).toBe(`${LABEL_NOT_APPLIED_NOTE}\n`);
    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft")], nextCursor: null } },
      [`PATCH /configurations/${ID}/versions/4`]: patched,
    });
    // --json: the note is one JSON object on stderr.
    const json = await cli(["--json", "config", "push", ID, "-f", file, "--label", "ignored"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stderr)).toEqual({ note: LABEL_NOT_APPLIED_NOTE });
    expect(JSON.parse(json.stdout)).toEqual({ action: "patched", versionNumber: 4, published: false });
  });

  it("checks --label locally: 1 to 80 characters once trimmed, as the API does (exit 2, no request)", async () => {
    routes({});
    expect(LABEL_MAXIMUM_LENGTH).toBe(CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH);
    for (const label of ["", "   ", "x".repeat(LABEL_MAXIMUM_LENGTH + 1), ` ${"é".repeat(LABEL_MAXIMUM_LENGTH + 1)} `]) {
      const refused = await cli(["config", "push", ID, "-f", file, "--label", label]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toBe(`error: ${LABEL_LENGTH_MESSAGE}\n`);
      expect(PublicCreateConfigurationVersionRequestSchema.safeParse({ yaml: YAML, label }).success).toBe(false);
    }
    expect((await cli(["config", "push", ID, "-f", file, "--description", "y".repeat(81)])).code).toBe(2);
    expect(fake.calls).toHaveLength(0);
    // The longest the API takes is taken.
    for (const label of ["x".repeat(LABEL_MAXIMUM_LENGTH), `  ${"x".repeat(LABEL_MAXIMUM_LENGTH)}  `, "a"]) {
      expect(PublicCreateConfigurationVersionRequestSchema.safeParse({ yaml: YAML, label }).success).toBe(true);
      routes({
        [`GET /configurations/${ID}/versions`]: { json: { items: [version(3, "published")], nextCursor: null } },
        "POST /validate": { json: { valid: true, collectorVersion: "0.147.0", errors: [] } },
        [`POST /configurations/${ID}/versions`]: { status: 201, json: { ...version(4, "draft"), configurationId: ID, yaml: YAML } },
      });
      expect((await cli(["config", "push", ID, "-f", file, "--label", label])).code).toBe(0);
    }
  });

  it("prints the validator's errors and exits 4 when the appended text is invalid, nothing saved", async () => {
    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(3, "published")], nextCursor: null } },
      "POST /validate": {
        json: {
          valid: false,
          collectorVersion: "0.147.0",
          errors: [
            { message: "unknown receiver", componentPath: "receivers::nope" },
            { message: "no pipelines", componentPath: null },
          ],
        },
      },
    });
    const result = await cli(["config", "push", ID, "-f", file, "--publish"]);
    expect(result.code).toBe(4);
    expect(requests()).toEqual([`GET /configurations/${ID}/versions`, "POST /validate"]);
    expect(result.stdout).toBe("Invalid:\n  - unknown receiver (receivers::nope)\n  - no pipelines\n");
    expect(result.stderr).toBe(`error: ${PUSH_INVALID_MESSAGE}\n`);
  });

  it("prints a 422 configuration_invalid's errors (exit 4), as JSON with --json", async () => {
    const errors = [{ message: "bad exporter", componentPath: "exporters::x" }];
    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft")], nextCursor: null } },
      [`PATCH /configurations/${ID}/versions/4`]: {
        status: 422,
        json: envelope("configuration_invalid", "The configuration isn't valid.", { errors }),
      },
    });
    const result = await cli(["--json", "config", "push", ID, "-f", file, "--publish"]);
    expect(result.code).toBe(4);
    expect(fake.calls).toHaveLength(2);
    expect(JSON.parse(result.stdout)).toEqual({ status: "invalid", errors });
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "check_failed", message: PUSH_INVALID_MESSAGE, status: null } });
  });

  it("says the version was saved but not published when the publish is refused (exit 1, its status kept)", async () => {
    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft")], nextCursor: null } },
      [`PATCH /configurations/${ID}/versions/4`]: patched,
      [`POST /configurations/${ID}/versions/4/publish`]: {
        status: 503,
        json: envelope("opamp_server_unavailable", "The fleet service is unavailable right now."),
      },
    });
    const result = await cli(["--json", "config", "push", ID, "-f", file, "--publish"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "opamp_server_unavailable",
        message: PUSH_NOT_PUBLISHED_MESSAGE(4, "The fleet service is unavailable right now."),
        status: 503,
      },
    });
    expect(PUSH_NOT_PUBLISHED_MESSAGE(4, "m")).toBe("Saved v4, but couldn't publish it: m");
  });

  it("keeps a publish's 401 and 403 as exit 3 with their words, the version saved", async () => {
    const answers: Array<[number, string, string, string]> = [
      [401, "invalid_api_token", "Missing or invalid API token", "Run telflo login."],
      [403, "insufficient_access", "This token can't do that.", READ_ONLY_TOKEN_MESSAGE],
    ];
    for (const [status, code, words, expected] of answers) {
      routes({
        [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft")], nextCursor: null } },
        [`PATCH /configurations/${ID}/versions/4`]: patched,
        [`POST /configurations/${ID}/versions/4/publish`]: { status, json: envelope(code, words) },
      });
      const result = await cli(["config", "push", ID, "-f", file, "--publish"]);
      expect(result.code).toBe(3);
      expect(result.stderr.startsWith("error: Saved v4, but couldn't publish it: ")).toBe(true);
      expect(result.stderr.includes(expected)).toBe(true);
      const json = JSON.parse((await cli(["--json", "config", "push", ID, "-f", file, "--publish"])).stderr) as { error: { code: string; status: number } };
      expect(json.error).toMatchObject({ code, status });
    }
  });

  it("keeps a 401 on the push itself as exit 3 with Run telflo login.", async () => {
    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft")], nextCursor: null } },
      [`PATCH /configurations/${ID}/versions/4`]: { status: 401, json: envelope("invalid_api_token", "Missing or invalid API token") },
    });
    const result = await cli(["config", "push", ID, "-f", file]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("error: Missing or invalid API token. Run telflo login.\n");
  });

  it("says to run it again after a 409 (another save first), exit 1", async () => {
    for (const code of ["configuration_version_changed", "configuration_version_published"]) {
      routes({
        [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft")], nextCursor: null } },
        [`PATCH /configurations/${ID}/versions/4`]: { status: 409, json: envelope(code, "Changed.") },
      });
      const result = await cli(["--json", "config", "push", ID, "-f", file]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr)).toEqual({ error: { code, message: PUSH_CHANGED_MESSAGE, status: 409 } });
    }
  });

  it("says nothing was saved when the validator couldn't check the text (503, exit 1); other refusals keep their words", async () => {
    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(3, "published")], nextCursor: null } },
      "POST /validate": { status: 503, json: envelope("validation_unavailable", "Validation is unavailable right now.") },
    });
    const unavailable = await cli(["config", "push", ID, "-f", file]);
    expect(unavailable.code).toBe(1);
    expect(unavailable.stderr).toBe(
      "error: Couldn't validate the configuration, so nothing was saved: Validation is unavailable right now.\n",
    );
    expect(fake.calls).toHaveLength(2);
    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft")], nextCursor: null } },
      [`PATCH /configurations/${ID}/versions/4`]: { status: 400, json: envelope("collector_version_retired", "That version is retired.") },
    });
    const retired = await cli(["config", "push", ID, "-f", file]);
    expect(retired.code).toBe(1);
    expect(retired.stderr).toBe("error: That version is retired.\n");
    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft")], nextCursor: null } },
      [`PATCH /configurations/${ID}/versions/4`]: { status: 409, json: envelope("something_else", "Something else.") },
    });
    expect((await cli(["config", "push", ID, "-f", file])).stderr).toBe("error: Something else.\n");
    for (const status of [409, 503]) {
      routes({
        [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft")], nextCursor: null } },
        [`PATCH /configurations/${ID}/versions/4`]: { status, text: "<html></html>", headers: { "content-type": "text/html" } },
      });
      const html = await cli(["config", "push", ID, "-f", file]);
      expect(html.code).toBe(1);
      expect(html.stderr.endsWith(`Unexpected reply (HTTP ${status}).\n`)).toBe(true);
    }
  });

  it("sends X-Telflo-Org for a person's token", async () => {
    store("person");
    routes({
      [`GET /configurations/${ID}/versions`]: { json: { items: [version(4, "draft")], nextCursor: null } },
      [`PATCH /configurations/${ID}/versions/4`]: patched,
    });
    expect((await cli(["config", "push", ID, "-f", file])).code).toBe(0);
    expect(fake.calls.map((call) => call.headers.get("x-telflo-org"))).toEqual([ORGANIZATION, ORGANIZATION]);
    expect(fake.calls.every((call) => call.headers.get("authorization") === `Bearer ${token}`)).toBe(true);
  });
});
