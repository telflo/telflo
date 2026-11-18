import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envelope, routedFetch, type Answer, type FakeFetch, type RecordedCall } from "../../tests/fake-fetch.js";
import { runCli, type CliRun } from "../../tests/run-cli.js";
import { deleteCredentials, saveCredentials, type TokenKind } from "../credentials.js";
import { NO_SERVER_MESSAGE } from "../server.js";
import { CONFIG_NEEDS_LOGIN_MESSAGE, SIGN_IN_TO_VALIDATE_MESSAGE, VALIDATION_FAILED_MESSAGE } from "./validate.js";

/*
 * telflo validate (D27 decision 26) against a stand-in API: logged in on
 * route 15, logged out on the anonymous route (no token, no organization),
 * --config's pin, and the exit codes (0, 4, 2 for a 400 about the request,
 * 1 for a 503). Tokens are made at run time and checked with boolean
 * canaries only.
 */

const SERVER = "https://telflo.example";
const ORGANIZATION = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const ID = "1c8f9bad-2e3f-4a41-9b5c-6d7e8f9a0b1c";
const YAML = "receivers:\n  otlp: {}\n";
const VALID = { valid: true, collectorVersion: "0.147.0", errors: [] };

let token: string;

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

function bodyOf(call: RecordedCall | undefined): unknown {
  return call?.body === undefined ? undefined : JSON.parse(call.body);
}

beforeEach(() => {
  token = `tf_${randomBytes(32).toString("base64url")}`;
  deleteCredentials();
  file = join(process.env.HOME!, `validate-${randomBytes(4).toString("hex")}.yaml`);
  writeFileSync(file, YAML);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("telflo validate, logged in (route 15)", () => {
  it("posts the file's YAML with the token and says it's valid", async () => {
    store();
    routes({ "POST /validate": { json: VALID } });
    const result = await cli(["validate", file]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Valid (collector 0.147.0).\n");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url.origin).toBe(SERVER);
    expect(bodyOf(fake.calls[0])).toEqual({ yaml: YAML });
    expect(fake.calls[0]?.headers.get("authorization") === `Bearer ${token}`).toBe(true);
    expect(result.stdout.includes(token) || result.stderr.includes(token)).toBe(false);
  });

  it("sends --distribution and --collector-version, and X-Telflo-Org for a person's token", async () => {
    store("person");
    routes({ "POST /validate": { json: VALID } });
    await cli(["validate", "-", "--distribution", "otelcol-k8s", "--collector-version", "0.146.0"], { input: YAML });
    expect(bodyOf(fake.calls[0])).toEqual({ yaml: YAML, distribution: "otelcol-k8s", collectorVersion: "0.146.0" });
    expect(fake.calls[0]?.headers.get("x-telflo-org")).toBe(ORGANIZATION);
  });

  it("prints the collector's errors and exits 4 when the text is invalid; --json prints the verdict", async () => {
    store();
    const invalid = {
      valid: false,
      collectorVersion: "0.147.0",
      errors: [
        { message: "unknown receiver", componentPath: "receivers::nope" },
        { message: "no pipelines", componentPath: null },
      ],
    };
    routes({ "POST /validate": { json: invalid } });
    const result = await cli(["validate", file]);
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("Invalid (collector 0.147.0):\n  - unknown receiver (receivers::nope)\n  - no pipelines\n");
    expect(result.stderr).toBe(`error: ${VALIDATION_FAILED_MESSAGE}\n`);
    const json = await cli(["--json", "validate", file]);
    expect(json.code).toBe(4);
    expect(JSON.parse(json.stdout)).toEqual(invalid);
  });

  it("validates on a stored configuration's pin with --config, an explicit flag still winning", async () => {
    store();
    const detail = {
      id: ID,
      name: "prod",
      description: "",
      organizationId: ORGANIZATION,
      isPublished: true,
      distribution: "otelcol-k8s",
      collectorVersion: "0.140.0",
      versionNumber: 2,
      publishedVersionNumber: 2,
      updatedAt: "2026-10-26T12:00:00.000Z",
      yaml: YAML,
    };
    routes({ [`GET /configurations/${ID}`]: { json: detail }, "POST /validate": { json: VALID } });
    const result = await cli(["validate", file, "--config", ID.toUpperCase()]);
    expect(result.code).toBe(0);
    expect(bodyOf(fake.calls[1])).toEqual({ yaml: YAML, distribution: "otelcol-k8s", collectorVersion: "0.140.0" });
    expect(result.stderr).toBe(`# validating on otelcol-k8s 0.140.0 (from configuration ${ID})\n`);
    routes({ [`GET /configurations/${ID}`]: { json: detail }, "POST /validate": { json: VALID } });
    const json = await cli(["--json", "validate", file, "--config", ID, "--collector-version", "0.147.0"]);
    expect(bodyOf(fake.calls[1])).toEqual({ yaml: YAML, distribution: "otelcol-k8s", collectorVersion: "0.147.0" });
    expect(json.stderr).toBe("");
  });

  it("is exit 2 for a 400 about the request (an unknown or retired version, a distribution), exit 1 for any other", async () => {
    store();
    for (const code of ["collector_version_unknown", "collector_version_retired", "collector_distribution_unknown", "invalid_request"]) {
      routes({ "POST /validate": { status: 400, json: envelope(code, "The catalogue has no such version.") } });
      const result = await cli(["--json", "validate", file]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr)).toEqual({ error: { code, message: "The catalogue has no such version.", status: 400 } });
    }
    routes({ "POST /validate": { status: 400, json: envelope("organization_required", "Name the organization.") } });
    expect((await cli(["validate", file])).code).toBe(1);
    routes({ "POST /validate": { status: 400, text: "<html>Bad Request</html>", headers: { "content-type": "text/html" } } });
    const html = await cli(["validate", file]);
    expect(html.code).toBe(1);
    expect(html.stderr).toBe("error: Unexpected reply (HTTP 400).\n");
  });

  it("keeps a logged-in 404 as the API's refusal, never the anonymous route's sign-in words (D36-1 Preflight ruling 8)", async () => {
    store();
    routes({ "POST /validate": { status: 404, json: envelope("not_found", "No route for POST /api/public/v1/validate") } });
    const result = await cli(["--json", "validate", file]);
    expect(result.code).not.toBe(3);
    expect(result.stderr.includes(SIGN_IN_TO_VALIDATE_MESSAGE)).toBe(false);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "not_found", status: 404 } });
  });

  it("keeps a 401 as exit 3 with Run telflo login. (Ruling 243)", async () => {
    store();
    routes({ "POST /validate": { status: 401, json: envelope("invalid_api_token", "Missing or invalid API token") } });
    const result = await cli(["validate", file]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("error: Missing or invalid API token. Run telflo login.\n");
  });

  it("is exit 1 when the validator couldn't check the text (503): not a verdict", async () => {
    store();
    routes({ "POST /validate": { status: 503, json: envelope("validation_unavailable", "Validation is unavailable right now.") } });
    const result = await cli(["validate", file]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("error: Couldn't validate (not a verdict on the YAML): Validation is unavailable right now.\n");
    routes({ "POST /validate": { status: 503, text: "<html>Service Unavailable</html>", headers: { "content-type": "text/html" } } });
    const html = await cli(["--json", "validate", file]);
    expect(html.code).toBe(1);
    expect(JSON.parse(html.stderr)).toEqual({
      error: { code: "api_error", message: "Couldn't validate (not a verdict on the YAML): Unexpected reply (HTTP 503).", status: 503 },
    });
  });

  it("uses TELFLO_TOKEN with TELFLO_SERVER", async () => {
    vi.stubEnv("TELFLO_TOKEN", token);
    vi.stubEnv("TELFLO_SERVER", "https://other.example");
    routes({
      "GET /whoami": { json: { kind: "service_account", tokenName: "ci", access: "read", organizationId: ORGANIZATION } },
      "POST /validate": { json: VALID },
    });
    expect((await cli(["validate", file])).code).toBe(0);
    expect(fake.calls.map((call) => `${call.url.origin} ${call.url.pathname}`)).toContain("https://other.example /api/public/v1/validate");
  });
});

describe("server strings in human lines (Ruling 237)", () => {
  it("strips control characters from the verdict's version and errors, and from --config's pin", async () => {
    store();
    const ESCAPE = "\u001b[2J\u0007";
    routes({
      [`GET /configurations/${ID}`]: { json: { distribution: `d${ESCAPE}`, collectorVersion: "0.1.0", versionNumber: 1 } },
      "POST /validate": { json: { valid: false, collectorVersion: `0.1.0${ESCAPE}`, errors: [{ message: `m${ESCAPE}`, componentPath: null }] } },
    });
    const result = await cli(["validate", file, "--config", ID]);
    expect(result.stdout).toBe("Invalid (collector 0.1.0[2J):\n  - m[2J\n");
    expect(result.stderr.startsWith("# validating on d[2J 0.1.0 (")).toBe(true);
    routes({ "POST /validate": { json: { valid: true, collectorVersion: `0.1.0${ESCAPE}`, errors: [] } } });
    expect((await cli(["validate", file])).stdout).toBe("Valid (collector 0.1.0[2J).\n");
  });
});

describe("telflo validate, not logged in (the anonymous route)", () => {
  it("posts to /validate/anonymous on TELFLO_SERVER, with no token and no organization", async () => {
    vi.stubEnv("TELFLO_SERVER", "https://telflo.example.com");
    routes({ "POST /validate/anonymous": { json: VALID } });
    const result = await cli(["validate", file, "--distribution", "otelcol-contrib"]);
    expect(result.code).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url.href).toBe("https://telflo.example.com/api/public/v1/validate/anonymous");
    expect(fake.calls[0]?.headers.has("authorization")).toBe(false);
    expect(fake.calls[0]?.headers.has("x-telflo-org")).toBe(false);
    expect(bodyOf(fake.calls[0])).toEqual({ yaml: YAML, distribution: "otelcol-contrib" });
  });

  it("has no default server: without TELFLO_SERVER it is exit 2, naming --server and TELFLO_SERVER, before any request", async () => {
    routes({ "POST /validate/anonymous": { json: VALID } });
    const result = await cli(["validate", file]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(`error: ${NO_SERVER_MESSAGE}\n`);
    expect(fake.calls).toHaveLength(0);
  });

  it("goes to TELFLO_SERVER, and keeps the exit codes", async () => {
    vi.stubEnv("TELFLO_SERVER", "http://127.0.0.1:4100");
    routes({ "POST /validate/anonymous": { json: { valid: false, collectorVersion: "0.147.0", errors: [] } } });
    const result = await cli(["validate", file]);
    expect(result.code).toBe(4);
    expect(fake.calls[0]?.url.origin).toBe("http://127.0.0.1:4100");
  });

  it("refuses --config without a login (exit 3), before any request; a usage error first is exit 2 (Ruling 249)", async () => {
    routes({});
    const result = await cli(["validate", file, "--config", ID]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe(`error: ${CONFIG_NEEDS_LOGIN_MESSAGE}\n`);
    expect((await cli(["validate", join(process.env.HOME!, "missing.yaml"), "--config", ID])).code).toBe(2);
    expect((await cli(["validate", file, "--config", "prod"])).code).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a file it can't read (exit 2)", async () => {
    routes({});
    expect((await cli(["validate", join(process.env.HOME!, "missing.yaml")])).code).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  it("says to log in (exit 3) when the server doesn't validate without one: its anonymous route answers 404 (D36-1 decision 31, Preflight ruling 8)", async () => {
    vi.stubEnv("TELFLO_SERVER", "https://telflo.example.com");
    routes({ "POST /validate/anonymous": { status: 404, json: envelope("not_found", "No route for POST /api/public/v1/validate/anonymous") } });
    const result = await cli(["validate", file]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe(`error: ${SIGN_IN_TO_VALIDATE_MESSAGE}\n`);
    expect(result.stdout).toBe("");

    const json = await cli(["--json", "validate", file]);
    expect(json.code).toBe(3);
    expect(JSON.parse(json.stderr)).toEqual({ error: { code: "login_required", message: SIGN_IN_TO_VALIDATE_MESSAGE, status: 404 } });
    // Fixed words: nothing of the server's reply.
    expect(json.stderr.includes("No route for")).toBe(false);
  });
});
