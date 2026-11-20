import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicTestRun, ValidationRuleResult } from "@telflo/contracts";
import { envelope, routedFetch, type Answer, type FakeFetch, type RecordedCall } from "../../tests/fake-fetch.js";
import { runCli, type CliRun } from "../../tests/run-cli.js";
import { ApiError } from "../api.js";
import { deleteCredentials, saveCredentials } from "../credentials.js";
import { ExitError, READ_ONLY_TOKEN_MESSAGE } from "../output.js";
import { setTestRunClock } from "../ops/test-runs.js";
import {
  savedCounts,
  cell,
  configurationRefusalOf,
  describeDetail,
  nameResults,
  NO_OUTPUT_MESSAGE,
  NOT_ENDED_MESSAGE,
  ONE_STDIN_MESSAGE,
  OUTPUT_NOT_SAVED_MESSAGE,
  positiveInteger,
  RULES_FAILED_MESSAGE,
  ruleRefusalOf,
  RUN_FAILED_MESSAGE,
  SAVE_AND_SAVED_MESSAGE,
  SAVED_NEEDS_VERSION_MESSAGE,
} from "./test.js";

/*
 * telflo test: each request's body, the statuses' exit codes, results by
 * position (inline) and by id (saved), --save's body, the refusals named,
 * on a stub fetch and a fake clock. The token is checked with boolean
 * canaries only.
 */

const SERVER = "https://telflo.example";
const ORGANIZATION = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const CONFIGURATION = "1c8f9bad-2e3f-4a41-9b5c-6d7e8f9a0b1c";
const RUN = "5e3b1c2d-4a5f-4b6c-8d7e-9f0a1b2c3d4e";
const SAVED_A = "6f4c2d3e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
const SAVED_B = "7a5d3e4f-6c7b-4d8e-8f9a-1b2c3d4e5f6a";
const PIPELINES = `/configurations/${CONFIGURATION}/versions/3/validation-pipelines`;

const SPEC = `
name: the older CLI's pipeline name
signal: logs
pipeline: logs/in
sample_text: '{"resourceLogs":[]}'
rules:
  - name: total
    context: log
    quantifier: count
    condition: "true"
    count: { operator: gte, value: 1 }
  - context: log
    quantifier: any
    condition: body != nil
`;

const INLINE_RULES = [
  { kind: "ottl", target: "output", name: "total", ottl: { context: "log", quantifier: "count", condition: "true", count: { operator: "gte", value: 1 } } },
  { kind: "ottl", target: "output", ottl: { context: "log", quantifier: "any", condition: "body != nil" } },
];

let dir: string;
let token: string;
let fake: FakeFetch;
let now: number;
let sleeps: number[];

function ruleResult(id: string, passed: boolean, extra: Partial<ValidationRuleResult> = {}): ValidationRuleResult {
  return { id, passed, error: null, advisory: null, detail: null, ...extra };
}

function run(status: PublicTestRun["status"], validationResults: ValidationRuleResult[] | null = null, extra: Partial<PublicTestRun> = {}): PublicTestRun {
  const ended = status !== "queued" && status !== "running";
  return {
    id: RUN,
    status,
    success: ended ? status === "succeeded" : null,
    signal: "logs",
    pipeline: "logs/in",
    durationMs: ended ? 1234 : null,
    collectorVersion: "0.147.0",
    distribution: "otelcol-contrib",
    validationResults,
    mutations: null,
    compatibility: null,
    errorMessage: null,
    createdAt: "2026-10-26T00:00:00.000Z",
    ...extra,
  };
}

const ENDED_RESULTS = [ruleResult("a1", true), ruleResult("a2", true)];

/** Routes for a run: queued, then the polls' runs in turn (the last repeated). */
function routes(polls: PublicTestRun[], extra: Record<string, Answer | ((call: RecordedCall) => Answer | Response)> = {}) {
  let poll = 0;
  return routedFetch({
    "POST /test-runs": { status: 202, json: { id: RUN, status: "queued" } },
    [`GET /test-runs/${RUN}`]: () => ({ json: polls[Math.min(poll++, polls.length - 1)] }),
    [`GET /test-runs/${RUN}/output`]: { text: "the output" },
    ...extra,
  });
}

function use(next: FakeFetch): FakeFetch {
  fake = next;
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

function specFile(text = SPEC): string {
  const path = join(dir, "spec.yaml");
  writeFileSync(path, text);
  return path;
}

function yamlFile(): string {
  const path = join(dir, "config.yaml");
  writeFileSync(path, "receivers: {}\n");
  return path;
}

function bodyOf(method: string, pathEnd: string): Record<string, unknown> {
  const call = fake.calls.find((each) => each.method === method && each.url.pathname.endsWith(pathEnd));
  return JSON.parse(call!.body!) as Record<string, unknown>;
}

function holdsToken(...texts: string[]): boolean {
  return texts.some((text) => text.includes(token));
}


/** `telflo …` in process, its output checked for the token (a boolean) before any test reads it. */
async function cli(args: readonly string[], options?: Parameters<typeof runCli>[1]): Promise<CliRun> {
  const ran = await runCli(args, options);
  expect([ran.stdout, ran.stderr].some((text) => text.includes(token))).toBe(false);
  return ran;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "telflo-cli-test-command-"));
  token = `tf_${randomBytes(32).toString("base64url")}`;
  deleteCredentials();
  saveCredentials({ version: 1, server: SERVER, token, kind: "person", tokenName: "laptop", organizationId: ORGANIZATION });
  now = 0;
  sleeps = [];
  setTestRunClock({
    now: () => now,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    },
  });
});

afterEach(() => {
  setTestRunClock();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("telflo test on a text (-f)", () => {
  it("queues the spec's converted rules in the public API's fields, polls to succeeded and names results by position (exit 0)", async () => {
    use(routes([run("queued"), run("running"), run("succeeded", ENDED_RESULTS)]));
    const result = await cli(["test", "--spec", specFile(), "-f", yamlFile()]);
    expect(result.code).toBe(0);
    expect(bodyOf("POST", "/test-runs")).toEqual({
      sample: '{"resourceLogs":[]}',
      signal: "logs",
      pipeline: "logs/in",
      durationSeconds: 5,
      rules: INLINE_RULES,
      yaml: "receivers: {}\n",
    });
    expect(fake.calls.every((call) => call.headers.get("x-telflo-org") === ORGANIZATION)).toBe(true);
    expect(sleeps).toEqual([1_000, 1_000]);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe(`Run ${RUN}: succeeded (1234 ms)`);
    expect(lines[1]?.split(/\s+/)).toEqual(["#", "rule", "result", "error", "advisory", "detail"]);
    expect(lines[3]?.startsWith("1  total   PASS")).toBe(true);
    expect(lines[4]?.startsWith("2  rule 2  PASS")).toBe(true);
    expect(result.stderr).toBe(`Test run ${RUN} queued: waiting for it to end.\n`);
    expect(holdsToken(result.stdout, result.stderr)).toBe(false);
  });

  it("--json: one document, the run with its named results and the rules' source", async () => {
    use(routes([run("succeeded", ENDED_RESULTS)]));
    const result = await cli(["--json", "test", "--spec", specFile(), "-f", yamlFile()]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ...run("succeeded", ENDED_RESULTS),
      rulesSource: "inline",
      results: [
        { ...ENDED_RESULTS[0], position: 1, name: "total" },
        { ...ENDED_RESULTS[1], position: 2, name: "rule 2" },
      ],
    });
  });

  it("validation_failed exits 4: the results' errors, advisories and details in their columns", async () => {
    const failing = [
      ruleResult("a1", false, {
        detail: { kind: "record_mismatch", context: "log", totalCount: 10, matchedCount: 7, missCount: 3, misses: [] },
        advisory: "An advisory\nover two lines.",
      }),
      ruleResult("a2", false, { error: "Not checked: a type error." }),
    ];
    use(routes([run("validation_failed", failing)]));
    const result = await cli(["test", "--spec", specFile(), "-f", yamlFile()]);
    expect(result.code).toBe(4);
    expect(result.stdout.includes("3 of 10 log records missed (7 matched)")).toBe(true);
    expect(result.stdout.includes("An advisory over two lines.")).toBe(true);
    expect(result.stdout.includes("Not checked: a type error.")).toBe(true);
    expect(result.stdout.split("\n")[3]?.includes("FAIL")).toBe(true);
    expect(result.stderr.endsWith(`error: ${RULES_FAILED_MESSAGE}\n`)).toBe(true);
  });

  it("failed exits 4 with the run's error message on stdout, never in the error", async () => {
    use(routes([run("failed", null, { errorMessage: "The collector exited." })]));
    const result = await cli(["--json", "test", "--spec", specFile(), "-f", yamlFile()]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed", errorMessage: "The collector exited.", results: [] });
    expect(JSON.parse(result.stderr)).toEqual({ error: { code: "test_run_failed", message: RUN_FAILED_MESSAGE, status: null } });

    use(routes([run("failed", null, { errorMessage: "The collector exited." })]));
    const human = await cli(["test", "--spec", specFile(), "-f", yamlFile()]);
    expect(human.stdout).toBe(`Run ${RUN}: failed (1234 ms)\nError: The collector exited.\n`);
  });

  it("no server string reaches the terminal with a control character: escape sequences are stripped", async () => {
    const escape = "\u001b[2J\u009b31m";
    use(
      routes([
        run("validation_failed", [ruleResult("a1", false, { error: `bad${escape}`, advisory: `note${escape}` })], {
          id: RUN,
          errorMessage: `exited${escape}`,
        }),
      ]),
    );
    const result = await cli(["test", "--spec", specFile(), "-f", yamlFile()]);
    expect(result.code).toBe(4);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(result.stdout + result.stderr)).toBe(false);
    expect(result.stdout.includes("Error: exited[2J31m")).toBe(true);
  });

  it("reads the spec from stdin, and refuses both from stdin", async () => {
    use(routes([run("succeeded", ENDED_RESULTS)]));
    expect((await cli(["test", "--spec", "-", "-f", yamlFile()], { input: SPEC })).code).toBe(0);
    const both = await cli(["test", "--spec", "-", "-f", "-"], { input: SPEC });
    expect(both.code).toBe(2);
    expect(both.stderr).toBe(`error: ${ONE_STDIN_MESSAGE}\n`);
  });

  it("a run that hasn't ended by --timeout exits 1 naming the run and its last status", async () => {
    use(routes([run("running")]));
    const result = await cli(["test", "--spec", specFile(), "-f", yamlFile(), "--timeout", "3"]);
    expect(result.code).toBe(1);
    expect(result.stderr.endsWith(`error: ${NOT_ENDED_MESSAGE(RUN, 3, "running")}\n`)).toBe(true);
    expect(now).toBe(3_000);
  });

  it("waits the run's duration and 120 s by default", async () => {
    use(routes([run("queued")]));
    const result = await cli(["test", "--spec", specFile(SPEC.replace("signal: logs", "duration: 10\nsignal: logs")), "-f", yamlFile()]);
    expect(result.code).toBe(1);
    expect(result.stderr.includes(NOT_ENDED_MESSAGE(RUN, 130, "queued"))).toBe(true);
    expect(now).toBeGreaterThanOrEqual(130_000);
  });

  it("--output saves the run's output; a run without one, or a path it can't write, is a warning", async () => {
    use(routes([run("succeeded", ENDED_RESULTS)]));
    const output = join(dir, "out.json");
    expect((await cli(["test", "--spec", specFile(), "-f", yamlFile(), "--output", output])).code).toBe(0);
    expect(readFileSync(output).equals(Buffer.from("the output"))).toBe(true);

    // The output's bytes exactly: a BOM, an invalid UTF-8 byte, no newline translation.
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62, 0x0a]);
    use(
      routes([run("succeeded", ENDED_RESULTS)], {
        [`GET /test-runs/${RUN}/output`]: () => new Response(bytes, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }),
      }),
    );
    const exact = join(dir, "exact.bin");
    expect((await cli(["test", "--spec", specFile(), "-f", yamlFile(), "--output", exact])).code).toBe(0);
    expect(readFileSync(exact).equals(bytes)).toBe(true);

    use(routes([run("succeeded", ENDED_RESULTS)], { [`GET /test-runs/${RUN}/output`]: { status: 404, json: envelope("test_run_output_not_found", "No output.") } }));
    const missing = await cli(["test", "--spec", specFile(), "-f", yamlFile(), "--output", join(dir, "none.json")]);
    expect(missing.code).toBe(0);
    expect(missing.stderr.includes(NO_OUTPUT_MESSAGE)).toBe(true);

    use(routes([run("succeeded", ENDED_RESULTS)]));
    const unwritable = await cli(["test", "--spec", specFile(), "-f", yamlFile(), "--output", dir]);
    expect(unwritable.code).toBe(0);
    expect(unwritable.stderr.includes(OUTPUT_NOT_SAVED_MESSAGE(dir))).toBe(true);
  });
});

describe("telflo test on a stored version (--config)", () => {
  const configuration = { id: CONFIGURATION, versionNumber: 3, collectorVersion: "0.140.0", distribution: "clickstack" };

  it("targets the latest version (route 5) with the spec's rules; no pin note", async () => {
    use(routes([run("succeeded", ENDED_RESULTS)], { [`GET /configurations/${CONFIGURATION}`]: { json: configuration } }));
    const result = await cli(["test", "--spec", specFile(), "--config", CONFIGURATION.toUpperCase()]);
    expect(result.code).toBe(0);
    expect(bodyOf("POST", "/test-runs")).toEqual({
      sample: '{"resourceLogs":[]}',
      signal: "logs",
      pipeline: "logs/in",
      durationSeconds: 5,
      rules: INLINE_RULES,
      configurationId: CONFIGURATION,
      versionNumber: 3,
    });
    expect(result.stderr.includes("Testing on")).toBe(false);
  });

  it("-f with --config runs the text on the configuration's pin, the flags first, and says so", async () => {
    use(routes([run("succeeded", ENDED_RESULTS)], { [`GET /configurations/${CONFIGURATION}`]: { json: configuration } }));
    const result = await cli(["test", "--spec", specFile(), "-f", yamlFile(), "--config", ` ${CONFIGURATION.toUpperCase()}`, "--collector-version", "0.147.0"]);
    expect(result.code).toBe(0);
    expect(bodyOf("POST", "/test-runs")).toMatchObject({ yaml: "receivers: {}\n", collectorVersion: "0.147.0", distribution: "clickstack" });
    expect(bodyOf("POST", "/test-runs").configurationId).toBeUndefined();
    expect(result.stderr.startsWith(`Testing on clickstack 0.147.0 (the pin of configuration ${CONFIGURATION} v3).\n`)).toBe(true);
  });

  it("--save PUTs { signal, rules } (no pipeline name), runs the saved rules and names results by id", async () => {
    const replaced = {
      id: "8b6e4f5a-7d8c-4e9f-9a0b-2c3d4e5f6a7b",
      pipeline: "logs/in",
      signal: "logs",
      versionNumber: 3,
      created: false,
      rulesReplaced: 1,
      rulesKept: 1,
      rules: [
        { id: SAVED_A, name: "a person's rule", isApiOwned: false },
        { id: SAVED_B, name: "total", isApiOwned: true },
      ],
    };
    use(
      routes([run("succeeded", [ruleResult(SAVED_B, true), ruleResult(SAVED_A, true)])], {
        [`PUT ${PIPELINES}/logs/in`]: { json: replaced },
      }),
    );
    const result = await cli(["test", "--spec", specFile(), "--config", CONFIGURATION, "--version", "3", "--save"]);
    expect(result.code).toBe(0);
    expect(bodyOf("PUT", "/validation-pipelines/logs/in")).toEqual({ signal: "logs", rules: INLINE_RULES });
    const queued = bodyOf("POST", "/test-runs");
    expect(queued).toMatchObject({ useSavedRules: true, configurationId: CONFIGURATION, versionNumber: 3 });
    expect("rules" in queued).toBe(false);
    expect(fake.calls.map((call) => `${call.method} ${call.url.pathname.replace("/api/public/v1", "")}`).slice(0, 2)).toEqual([
      `PUT ${PIPELINES}/logs/in`,
      "POST /test-runs",
    ]);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe("Saved 2 rules to the logs/in validation pipeline of version 3 (replaced 1 API-owned, kept 1).");
    expect(lines[4]?.startsWith("1  total")).toBe(true);
    expect(lines[5]?.startsWith("2  a person's rule")).toBe(true);

    use(routes([run("succeeded", [ruleResult(SAVED_B, true)])], { [`PUT ${PIPELINES}/logs/in`]: { json: replaced } }));
    const json = await cli(["--json", "test", "--spec", specFile(), "--config", CONFIGURATION, "--version", "3", "--save"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      rulesSource: "saved",
      results: [{ id: SAVED_B, name: "total", position: 1 }],
      savedPipeline: { id: replaced.id, pipeline: "logs/in", created: false, rulesReplaced: 1, rulesKept: 1 },
    });
  });

  it("--saved runs the version's saved rules, names results from route 13 by id, and ignores the spec's rules", async () => {
    use(
      routes([run("succeeded", [ruleResult(SAVED_A, true), ruleResult("9c7f5a6b-8e9d-4f0a-8b1c-3d4e5f6a7b8c", true)])], {
        [`GET ${PIPELINES}`]: {
          json: {
            items: [
              { pipeline: "logs/other", rules: [{ id: SAVED_B, name: "elsewhere" }] },
              { pipeline: "logs/in", rules: [{ id: SAVED_A, name: "saved one" }] },
            ],
            nextCursor: null,
          },
        },
      }),
    );
    const result = await cli(["test", "--spec", specFile(), "--config", CONFIGURATION, "--version", "3", "--saved"]);
    expect(result.code).toBe(0);
    expect(result.stderr.startsWith("Ignoring the spec's 2 rules: --saved runs the version's saved rules.\n")).toBe(true);
    const queued = bodyOf("POST", "/test-runs");
    expect(queued).toMatchObject({ useSavedRules: true, versionNumber: 3 });
    expect("rules" in queued).toBe(false);
    const lines = result.stdout.split("\n");
    expect(lines[3]?.startsWith("1  saved one")).toBe(true);
    expect(lines[4]?.startsWith("2  rule 2")).toBe(true);
  });

  it("--saved with no saved rules is the API's 422: its message and errors' words, exit 1", async () => {
    use(
      routes([], {
        [`GET ${PIPELINES}`]: { json: { items: [], nextCursor: null } },
        "POST /test-runs": {
          status: 422,
          json: envelope("configuration_invalid", "The configuration is not valid.", {
            errors: [{ message: "The version has no saved validation rules for this pipeline.", componentPath: null }],
          }),
        },
      }),
    );
    const result = await cli(["--json", "test", "--spec", specFile(SPEC.split("rules:")[0]), "--config", CONFIGURATION, "--version", "3", "--saved"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "configuration_invalid",
        message: "The configuration is not valid. The version has no saved validation rules for this pipeline.",
        status: 422,
      },
    });
  });
});

describe("telflo test's refusals", () => {
  it.each([
    [["--save", "--saved", "--config", CONFIGURATION], SAVE_AND_SAVED_MESSAGE],
    [["--save", "-f", "x.yaml", "--config", CONFIGURATION], SAVED_NEEDS_VERSION_MESSAGE],
    [["--saved", "-f", "x.yaml"], SAVED_NEEDS_VERSION_MESSAGE],
    [[], "Give -f <file>, --config <id>, or both"],
    [["-f", "x.yaml", "--version", "2"], "--version needs --config <id>."],
  ])("usage %j is exit 2 before any request", async (args, message) => {
    use(routes([]));
    const result = await cli(["test", "--spec", specFile(), ...args]);
    expect(result.code).toBe(2);
    expect(result.stderr.includes(message)).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("a --version or --timeout that isn't a whole number from 1 is commander's usage error", async () => {
    use(routes([]));
    for (const args of [["--version", "0"], ["--version", "x"], ["--timeout", "-1"], ["--timeout", "1.5"]]) {
      expect((await cli(["test", "--spec", specFile(), "--config", CONFIGURATION, ...args])).code).toBe(2);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("a spec rule the API would refuse is exit 2 naming its index and field, nothing sent", async () => {
    use(routes([]));
    const result = await cli(["test", "--spec", specFile(SPEC.replace("quantifier: any", "quantifier: any\n    count: { operator: eq, value: 1 }")), "-f", yamlFile()]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("error: test spec: rules[1].count is for count and distinct only.\n");
    expect(fake.calls).toHaveLength(0);
  });

  it("the server's refusal of a rule (invalid_request at rules.N, validation_rule_invalid's ruleIndex) is named the same way, exit 2", async () => {
    use(
      routes([], {
        "POST /test-runs": {
          status: 400,
          json: envelope("invalid_request", "The request was not valid.", [{ path: ["rules", 1, "ottl", "context"], message: "The pipeline's signal doesn't have this OTTL context." }]),
        },
      }),
    );
    const context = await cli(["test", "--spec", specFile(), "-f", yamlFile()]);
    expect(context.code).toBe(2);
    expect(context.stderr).toBe("error: test spec: the server refused rules[1].context.\n");

    const quoted = "quoted-condition-marker";
    use(
      routes([], {
        "POST /test-runs": {
          status: 400,
          json: envelope("validation_rule_invalid", "A rule is not valid: see the problems in details.", {
            ruleIndex: 0,
            problems: [{ field: "ottl.condition", message: `OTTL syntax error near ${quoted}` }],
          }),
        },
      }),
    );
    const invalid = await cli(["test", "--spec", specFile(), "-f", yamlFile()]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toBe("error: test spec: rules[0] isn't a valid rule (condition): the server's rule check refused it.\n");
    expect(invalid.stderr.includes(quoted)).toBe(false);
  });

  it("--save's PUT refusing a rule is named the same way", async () => {
    use(
      routes([], {
        [`PUT ${PIPELINES}/logs/in`]: {
          status: 400,
          json: envelope("validation_rule_invalid", "A rule is not valid: see the problems in details.", { ruleIndex: 1, problems: [] }),
        },
      }),
    );
    const result = await cli(["test", "--spec", specFile(), "--config", CONFIGURATION, "--version", "3", "--save"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("error: test spec: rules[1] isn't a valid rule: the server's rule check refused it.\n");
    expect(fake.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("a full queue's 429 (no Retry-After) isn't retried: its message, exit 1", async () => {
    use(
      routes([], {
        "POST /test-runs": { status: 429, json: envelope("test_run_queue_full", "You have 50 test runs waiting already. Wait for some to finish.") },
      }),
    );
    const result = await cli(["test", "--spec", specFile(), "-f", yamlFile()]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("error: You have 50 test runs waiting already. Wait for some to finish.\n");
    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("the runs' minute 429 (with Retry-After) is retried after it, with one stderr line", async () => {
    let posts = 0;
    use(
      routes([run("succeeded", ENDED_RESULTS)], {
        "POST /test-runs": () =>
          posts++ === 0
            ? { status: 429, json: envelope("test_run_rate_limited", "Too many test runs."), headers: { "retry-after": "12" } }
            : { status: 202, json: { id: RUN, status: "queued" } },
      }),
    );
    const result = await cli(["test", "--spec", specFile(), "-f", yamlFile()]);
    expect(result.code).toBe(0);
    expect(sleeps[0]).toBe(12_000);
    expect(result.stderr.startsWith("Rate limited: retrying in 12 s.\n")).toBe(true);
  });

  it("a collector the catalogue doesn't offer is exit 2, as validate's, its code and status kept", async () => {
    for (const code of ["collector_version_unknown", "collector_version_retired", "collector_distribution_unknown"]) {
      use(routes([], { "POST /test-runs": { status: 400, json: envelope(code, "That collector isn't in the catalogue.") } }));
      const human = await cli(["test", "--spec", specFile(), "-f", yamlFile(), "--collector-version", "0.1.0"]);
      expect(human.code).toBe(2);
      expect(human.stderr).toBe("error: That collector isn't in the catalogue.\n");
      const json = await cli(["--json", "test", "--spec", specFile(), "-f", yamlFile(), "--collector-version", "0.1.0"]);
      expect(json.code).toBe(2);
      expect(JSON.parse(json.stderr)).toEqual({ error: { code, message: "That collector isn't in the catalogue.", status: 400 } });
    }
    // Any other 400 keeps its own ending.
    use(routes([], { "POST /test-runs": { status: 400, json: envelope("test_run_sample_too_large", "The sample is too large.") } }));
    expect((await cli(["test", "--spec", specFile(), "-f", yamlFile()])).code).toBe(1);
  });

  it("--json keeps stderr JSON only: the --saved note, the 429's wait and the --output warning are one JSON object a line", async () => {
    let posts = 0;
    use(
      routes([run("succeeded", [ruleResult(SAVED_A, true)])], {
        [`GET ${PIPELINES}`]: { json: { items: [], nextCursor: null } },
        "POST /test-runs": () =>
          posts++ === 0
            ? { status: 429, json: envelope("test_run_rate_limited", "Too many test runs."), headers: { "retry-after": "3" } }
            : { status: 202, json: { id: RUN, status: "queued" } },
        [`GET /test-runs/${RUN}/output`]: { status: 404, json: envelope("test_run_output_not_found", "No output.") },
      }),
    );
    const result = await cli(["--json", "test", "--spec", specFile(), "--config", CONFIGURATION, "--version", "3", "--saved", "--output", join(dir, "out.txt")]);
    expect(result.code).toBe(0);
    expect(result.stderr.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as unknown)).toEqual([
      { note: "Ignoring the spec's 2 rules: --saved runs the version's saved rules." },
      { note: "Rate limited: retrying in 3 s." },
      { note: NO_OUTPUT_MESSAGE },
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: RUN, status: "succeeded", rulesSource: "saved" });
  });

  it("a read token's 403 is exit 3, and not logged in is exit 3", async () => {
    use(routes([], { "POST /test-runs": { status: 403, json: envelope("insufficient_access", "This token can't make changes.") } }));
    const readOnly = await cli(["test", "--spec", specFile(), "-f", yamlFile()]);
    expect(readOnly.code).toBe(3);
    expect(readOnly.stderr).toBe(`error: ${READ_ONLY_TOKEN_MESSAGE}\n`);
    deleteCredentials();
    expect((await cli(["test", "--spec", specFile(), "-f", yamlFile()])).code).toBe(3);
  });

  it("an unreadable spec is exit 2", async () => {
    use(routes([]));
    expect((await cli(["test", "--spec", join(dir, "missing.yaml"), "-f", yamlFile()])).code).toBe(2);
  });
});

describe("the helpers", () => {
  it("describeDetail: a detail's kind and counts, never its snippets", () => {
    expect(describeDetail(null)).toBe("");
    expect(describeDetail({ kind: "no_match", source: "output", searchedCharacters: 42 })).toBe("no match in output (42 characters searched)");
    const match = { text: "snippet-marker", textTruncated: false, before: "", after: "", record: { line: 1 } };
    expect(describeDetail({ kind: "unexpected_match", source: "stderr", totalMatchCount: 3, moreMatches: true, matches: [match] })).toBe(
      "3+ unexpected matches in stderr",
    );
    expect(describeDetail({ kind: "unexpected_match", source: "output", totalMatchCount: 1, moreMatches: false, matches: [match] })).toBe(
      "1 unexpected matches in output",
    );
    expect(describeDetail({ kind: "distinct_mismatch", totalCount: 9, matchedCount: 5, distinctCount: 2, samples: ["sample-marker"] })).toBe(
      "2 distinct values in 5 of 9 records",
    );
  });

  it("nameResults: by position or by id, `rule N` for none or an empty name; null results are none", () => {
    expect(nameResults(null, { byPosition: [] })).toEqual([]);
    expect(nameResults([ruleResult("x", true), ruleResult("y", false)], { byPosition: ["first", ""] }).map((each) => each.name)).toEqual(["first", "rule 2"]);
    expect(nameResults([ruleResult("y", true), ruleResult("x", true)], { byId: new Map([["x", "ex"]]) }).map((each) => each.name)).toEqual(["rule 1", "ex"]);
  });

  it("cell: one line, control characters out, long text cut", () => {
    expect(cell(null)).toBe("");
    expect(cell(undefined)).toBe("");
    // Breaks and tabs become one space; every other control character goes (terminalText).
    expect(cell(" a\n\tb\u0007c\u009b ")).toBe("a bc");
    expect(cell("x".repeat(400))).toBe(`${"x".repeat(300)}…`);
  });

  it("savedCounts and the run's duration: printed only when they are counts", async () => {
    expect(savedCounts({ rulesReplaced: 2, rulesKept: 0 })).toBe("replaced 2 API-owned, kept 0");
    for (const bad of [-1, 1.5, "3", null]) {
      expect(savedCounts({ rulesReplaced: bad as number, rulesKept: 1 })).toBe("the server's counts were unreadable");
      expect(savedCounts({ rulesReplaced: 1, rulesKept: bad as number })).toBe("the server's counts were unreadable");
    }
    use(routes([run("succeeded", null, { durationMs: "12\u001b[2J" as unknown as number })]));
    const odd = await cli(["test", "--spec", specFile(), "-f", yamlFile()]);
    expect(odd.code).toBe(0);
    expect(odd.stdout).toBe(`Run ${RUN}: succeeded\n`);
  });

  it("positiveInteger: whole numbers from 1", () => {
    const parse = positiveInteger("--version");
    expect(parse("7")).toBe(7);
    for (const bad of ["0", "-1", "1.5", "x", "", "1234567890"]) expect(() => parse(bad)).toThrow("--version must be a whole number from 1.");
  });

  it("ruleRefusalOf and configurationRefusalOf leave every other error alone", () => {
    expect(ruleRefusalOf(new Error("x"))).toBeUndefined();
    expect(ruleRefusalOf(new ApiError(422, "validation_rule_invalid", "m", { ruleIndex: 0 }))).toBeUndefined();
    expect(ruleRefusalOf(new ApiError(400, "validation_rule_invalid", "m", { ruleIndex: "0" }))).toBeUndefined();
    expect(ruleRefusalOf(new ApiError(400, "validation_rule_invalid", "m"))).toBeUndefined();
    expect(ruleRefusalOf(new ApiError(400, "invalid_request", "m", [{ path: ["pipeline"] }, null]))).toBeUndefined();
    expect(ruleRefusalOf(new ApiError(400, "invalid_request", "m", { path: ["rules", 0] }))).toBeUndefined();
    // A path below the rule the spec has no field for names the rule alone.
    expect(ruleRefusalOf(new ApiError(400, "invalid_request", "m", [{ path: ["rules", 2, "kind"] }]))?.message).toBe("test spec: the server refused rules[2].");
    expect(
      ruleRefusalOf(new ApiError(400, "validation_rule_invalid", "m", { ruleIndex: 1, problems: [{ field: "pattern" }, { field: 3 }, null, { field: "ottl.count.value" }] }))
        ?.message,
    ).toBe("test spec: rules[1] isn't a valid rule (count.value): the server's rule check refused it.");
    expect(ruleRefusalOf(new ApiError(400, "invalid_request", "m", [{ path: ["rules", 0, "ottl", "count", "value2"] }]))).toBeInstanceOf(ExitError);
    // A 401 or 403 is never reworded as a rule's refusal: endingOf keeps it exit 3.
    expect(ruleRefusalOf(new ApiError(401, "invalid_api_token", "m", [{ path: ["rules", 0, "kind"] }]))).toBeUndefined();
    expect(ruleRefusalOf(new ApiError(403, "insufficient_access", "m", { ruleIndex: 0 }))).toBeUndefined();
    // The refusal's HTTP status is kept for --json.
    expect(ruleRefusalOf(new ApiError(400, "invalid_request", "m", [{ path: ["rules", 0, "kind"] }]))?.status).toBe(400);
    expect(ruleRefusalOf(new ApiError(400, "validation_rule_invalid", "m", { ruleIndex: 0 }))?.status).toBe(400);
    expect(configurationRefusalOf(new Error("x"))).toBeUndefined();
    expect(configurationRefusalOf(new ApiError(422, "configuration_invalid", "m"))).toBeUndefined();
    expect(configurationRefusalOf(new ApiError(422, "configuration_invalid", "m", { errors: [{ message: 1 }] }))).toBeUndefined();
    expect(configurationRefusalOf(new ApiError(400, "configuration_invalid", "m", { errors: [{ message: "w" }] }))).toBeUndefined();
  });
});
