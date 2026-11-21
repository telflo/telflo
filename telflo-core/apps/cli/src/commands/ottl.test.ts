import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envelope, routedFetch, type Answer, type FakeFetch, type RecordedCall } from "../../tests/fake-fetch.js";
import { runCli, type CliRun } from "../../tests/run-cli.js";
import { deleteCredentials, saveCredentials } from "../credentials.js";
import { EXPRESSION_TOO_LONG_MESSAGE, EXPR_NEEDS_CONTEXT_MESSAGE, NO_INPUT_MESSAGE, NOTHING_TO_LINT_MESSAGE, TOO_MANY_EXPRESSIONS_MESSAGE } from "../ops/ottl.js";
import { LINT_FAILED_MESSAGE, YAML_INVALID_MESSAGE } from "./ottl.js";

/*
 * telflo ottl lint against a stand-in API: both modes' bodies
 * (`valueExpressions`), the rendering (`ottlVersion`), and the exit codes: 0,
 * 4 for an invalid expression or YAML, 2 for usage, 1 for a 503. Tokens are
 * made at run time and checked as booleans only.
 */

const SERVER = "https://telflo.example";
const ORGANIZATION = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const CONFIG = "processors:\n  filter:\n    logs:\n      log_record:\n        - IsMatch(body, \"debug\")\n";

const ITEM = {
  kind: "condition",
  index: 0,
  input: 'attributes["a"] == 1',
  valid: true,
  error: null,
  context: "log",
  location: null,
  note: null,
};

const OK = { valid: true, ottlVersion: "v0.147.0", checked: 1, items: [ITEM], skipped: [] };

let token: string;

/** Runs the CLI; its output is checked for the token (a boolean) before any test reads it. */
async function cli(...args: Parameters<typeof runCli>): Promise<CliRun> {
  const result = await runCli(...args);
  expect(result.stdout.includes(token) || result.stderr.includes(token)).toBe(false);
  return result;
}
let fake: FakeFetch;

function routes(table: Record<string, Answer | ((call: RecordedCall) => Answer)>): FakeFetch {
  fake = routedFetch(table);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

function bodyOf(index = 0): unknown {
  const body = fake.calls[index]?.body;
  return body === undefined ? undefined : JSON.parse(body);
}

beforeEach(() => {
  token = `tf_${randomBytes(32).toString("base64url")}`;
  deleteCredentials();
  saveCredentials({ version: 1, server: SERVER, token, kind: "service_account", tokenName: "ci", organizationId: ORGANIZATION });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telflo ottl lint", () => {
  it("sends a configuration's YAML without --context, and prints every item and the summary", async () => {
    const path = join(process.env.HOME!, "lint.yaml");
    writeFileSync(path, CONFIG);
    routes({
      "POST /ottl/lint": {
        json: {
          valid: false,
          ottlVersion: "v0.147.0",
          checked: 2,
          skipped: ["connectors.routing.table[2].condition: the request context isn't linted"],
          items: [
            { ...ITEM, location: "processors.filter.logs.log_record[0]" },
            {
              ...ITEM,
              kind: "statement",
              index: 1,
              input: "BAD(",
              valid: false,
              error: "1:1: unexpected token",
              location: "processors.transform.log_statements[0].statements[0]",
              note: "context inferred as log",
            },
          ],
        },
      },
    });
    const result = await cli(["ottl", "lint", path]);
    expect(result.code).toBe(4);
    expect(bodyOf()).toEqual({ yaml: CONFIG });
    expect(result.stdout).toBe(
      [
        "ok   processors.filter.logs.log_record[0]",
        '      attributes["a"] == 1',
        "FAIL processors.transform.log_statements[0].statements[0]",
        "      BAD(",
        "      error: 1:1: unexpected token",
        "      note:  context inferred as log",
        "skip  connectors.routing.table[2].condition: the request context isn't linted",
        "1 of 2 expressions invalid (OTTL v0.147.0).",
        "",
      ].join("\n"),
    );
    expect(result.stderr).toBe(`error: ${LINT_FAILED_MESSAGE}\n`);
    expect(result.stdout.includes(token) || result.stderr.includes(token)).toBe(false);
  });

  it("lints --expr and a file's lines against --context, as the kind asked", async () => {
    routes({ "POST /ottl/lint": { json: OK } });
    const conditions = await cli(["ottl", "lint", "-", "--context", "span", "--expr", "status.code == 1"], {
      input: '# a comment\n\nname == "x"\n',
    });
    expect(conditions.code).toBe(0);
    expect(bodyOf()).toEqual({ context: "span", conditions: ["status.code == 1", 'name == "x"'] });
    expect(conditions.stdout).toBe(['ok   condition[0]', '      attributes["a"] == 1', "All 1 expressions parse (OTTL v0.147.0).", ""].join("\n"));
    routes({ "POST /ottl/lint": { json: OK } });
    await cli(["ottl", "lint", "--context", "log", "--kind", "statement", "--expr", "set(a, 1)"]);
    expect(bodyOf()).toEqual({ context: "log", statements: ["set(a, 1)"] });
    for (const kind of ["value", "valueExpression"]) {
      routes({ "POST /ottl/lint": { json: OK } });
      await cli(["ottl", "lint", "--context", "log", "--kind", kind, "--expr", "body"]);
      expect(bodyOf()).toEqual({ context: "log", valueExpressions: ["body"] });
    }
  });

  it("prints the reply as JSON with --json, and says when a YAML holds no OTTL", async () => {
    const none = { valid: true, ottlVersion: null, checked: 0, items: [], skipped: [] };
    routes({ "POST /ottl/lint": { json: none } });
    expect(JSON.parse((await cli(["--json", "ottl", "lint", "-"], { input: "receivers: {}\n" })).stdout)).toEqual(none);
    routes({ "POST /ottl/lint": { json: none } });
    expect((await cli(["ottl", "lint", "-"], { input: "receivers: {}\n" })).stdout).toBe("No OTTL expressions found.\n");
  });

  it("refuses usage errors before any request (exit 2)", async () => {
    routes({});
    const cases: Array<[string[], string | null]> = [
      [["ottl", "lint"], NO_INPUT_MESSAGE],
      [["ottl", "lint", "--expr", "true"], EXPR_NEEDS_CONTEXT_MESSAGE],
      [["ottl", "lint", "--context", "log"], NOTHING_TO_LINT_MESSAGE],
      [["ottl", "lint", "--context", "trace", "--expr", "true"], null],
      [["ottl", "lint", "--context", "log", "--kind", "query", "--expr", "true"], null],
    ];
    for (const [args, message] of cases) {
      const result = await cli(args);
      expect(result.code).toBe(2);
      if (message !== null) expect(result.stderr).toBe(`error: ${message}\n`);
    }
    const long = await cli(["ottl", "lint", "--context", "log", "--expr", "true", "--expr", "x".repeat(8_193)]);
    expect(long.code).toBe(2);
    expect(long.stderr).toBe(`error: ${EXPRESSION_TOO_LONG_MESSAGE(1)}\n`);
    const many = await cli(["ottl", "lint", "-", "--context", "log"], { input: Array.from({ length: 201 }, () => "true").join("\n") });
    expect(many.code).toBe(2);
    expect(many.stderr).toBe(`error: ${TOO_MANY_EXPRESSIONS_MESSAGE}\n`);
    expect(fake.calls).toHaveLength(0);
  });

  it("prints a YAML's 422 errors (exit 4), and a 503 is exit 1: nothing checked", async () => {
    const errors = [{ message: "mapping values are not allowed here", componentPath: null }];
    routes({ "POST /ottl/lint": { status: 422, json: envelope("configuration_invalid", "The configuration isn't valid.", { errors }) } });
    const invalid = await cli(["ottl", "lint", "-"], { input: "a: b: c\n" });
    expect(invalid.code).toBe(4);
    expect(invalid.stdout).toBe("Invalid YAML:\n  - mapping values are not allowed here\n");
    expect(invalid.stderr).toBe(`error: ${YAML_INVALID_MESSAGE}\n`);
    routes({ "POST /ottl/lint": { status: 503, json: envelope("ottl_lint_unavailable", "OTTL lint is unavailable right now.") } });
    const unavailable = await cli(["ottl", "lint", "--context", "log", "--expr", "true"]);
    expect(unavailable.code).toBe(1);
    expect(unavailable.stderr).toBe("error: Couldn't lint (not a verdict on the OTTL): OTTL lint is unavailable right now.\n");
    routes({ "POST /ottl/lint": { status: 503, text: "<html>Service Unavailable</html>", headers: { "content-type": "text/html" } } });
    expect((await cli(["ottl", "lint", "--context", "log", "--expr", "true"])).stderr).toBe(
      "error: Couldn't lint (not a verdict on the OTTL): Unexpected reply (HTTP 503).\n",
    );
    routes({ "POST /ottl/lint": { status: 400, json: envelope("invalid_request", "The configuration holds more than 200 OTTL expressions.") } });
    const refused = await cli(["--json", "ottl", "lint", "-"], { input: CONFIG });
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr)).toEqual({
      error: { code: "invalid_request", message: "The configuration holds more than 200 OTTL expressions.", status: 400 },
    });
    routes({ "POST /ottl/lint": { status: 400, json: envelope("organization_required", "Name the organization.") } });
    expect((await cli(["ottl", "lint", "-"], { input: CONFIG })).code).toBe(1);
  });

  it("keeps the HTTP status in --json for a YAML's 422 and a 503", async () => {
    routes({ "POST /ottl/lint": { status: 422, json: envelope("configuration_invalid", "The configuration isn't valid.", { errors: [] }) } });
    expect(JSON.parse((await cli(["--json", "ottl", "lint", "-"], { input: "a: b: c\n" })).stderr)).toEqual({
      error: { code: "configuration_invalid", message: YAML_INVALID_MESSAGE, status: 422 },
    });
    routes({ "POST /ottl/lint": { status: 503, json: envelope("ottl_lint_unavailable", "Unavailable.") } });
    expect(JSON.parse((await cli(["--json", "ottl", "lint", "--context", "log", "--expr", "true"])).stderr)).toMatchObject({
      error: { code: "ottl_lint_unavailable", status: 503 },
    });
  });

  it("keeps a 401 as exit 3 with Run telflo login.", async () => {
    routes({ "POST /ottl/lint": { status: 401, json: envelope("invalid_api_token", "Missing or invalid API token") } });
    const result = await cli(["ottl", "lint", "-"], { input: CONFIG });
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("error: Missing or invalid API token. Run telflo login.\n");
  });

  it("exits 3 when not logged in", async () => {
    deleteCredentials();
    routes({});
    expect((await cli(["ottl", "lint", "--context", "log", "--expr", "true"])).code).toBe(3);
    expect(fake.calls).toHaveLength(0);
  });
});
