import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GROUP_ID, MINE, VERSION_ID } from "~/test/configurations.js";
import { testFileFixture, testRunFixture } from "~/test/test-runs.js";
import { testDefinitionFixture, testSuiteFixture } from "~/test/test-suites.js";
import { validationPipelineFixture, validationRuleFixture } from "~/test/validation-pipelines.js";

/*
 * The browser client's testing calls (D14a decision 28; Preflight rulings
 * 10, 14 and 15), against a fake API behind a custom axios adapter, as
 * api-client.test.ts does: My Files' list, upload, paste and delete; the
 * queue; a version's runs, a run, and a run's file as bytes.
 */

const analytics = vi.hoisted(() => ({ signedOutLocally: vi.fn() }));
vi.mock("~/lib/analytics.js", () => analytics);

type SeenRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  responseType: string | undefined;
};

/** An answer: JSON (`body`), bytes (`bytes`), or a JSON envelope sent as bytes (`envelopeAsBytes`), as a browser hands an arraybuffer read's refusal over. */
type Reply = { status: number; body?: unknown; bytes?: Uint8Array; envelopeAsBytes?: boolean; headers?: Record<string, string> };

const api = {
  routes: {} as Record<string, (request: SeenRequest) => Reply>,
  requests: [] as SeenRequest[],
};

async function loadClient() {
  vi.resetModules();
  const { default: axios, AxiosError, AxiosHeaders } = await import("axios");
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const seen: SeenRequest = {
      method: (config.method ?? "get").toUpperCase(),
      url: `${config.baseURL ?? ""}${config.url ?? ""}`,
      headers: Object.fromEntries(Object.entries(config.headers.toJSON()).map(([name, value]) => [name.toLowerCase(), String(value)])),
      body: typeof config.data === "string" ? JSON.parse(config.data) : config.data,
      responseType: config.responseType,
    };
    api.requests.push(seen);
    const route = api.routes[`${seen.method} ${seen.url}`];
    const reply: Reply = route
      ? route(seen)
      : { status: 404, body: { error: { code: "not_found", message: `No route ${seen.method} ${seen.url}` } } };
    const json = reply.body === undefined ? "" : JSON.stringify(reply.body);
    const data =
      reply.bytes !== undefined
        ? reply.bytes.buffer.slice(reply.bytes.byteOffset, reply.bytes.byteOffset + reply.bytes.byteLength)
        : reply.envelopeAsBytes
          ? new TextEncoder().encode(json).buffer
          : json;
    const response = {
      data,
      status: reply.status,
      statusText: "",
      headers: new AxiosHeaders({ "content-type": reply.bytes ? "application/octet-stream" : "application/json", ...reply.headers }),
      config,
      request: {},
    };
    if (config.validateStatus ? config.validateStatus(reply.status) : true) return response;
    throw new AxiosError(`Request failed with status code ${reply.status}`, AxiosError.ERR_BAD_REQUEST, config, {}, response);
  };
  axios.defaults.adapter = adapter;
  return import("./api-client.js");
}

let client: Awaited<ReturnType<typeof loadClient>>;

beforeAll(async () => {
  client = await loadClient();
});

beforeEach(() => {
  api.routes = {};
  api.requests = [];
  client.setSessionEndedHandler(vi.fn());
});

const FILES = `/api/v1/organizations/${GROUP_ID}/test-files`;
const RUNS = `/api/v1/organizations/${GROUP_ID}/configurations/${MINE.id}/versions/${VERSION_ID}/test-runs`;
const FILE = testFileFixture();
const RUN = testRunFixture();
const { configurationId: _c, versionId: _v, sourceRunId: _s, yaml: _y, collectorDistribution: _d, inputSizeBytes: _i,
  inputContentType: _t, strategy: _st, kwokEnabled: _k, mutatedYaml: _m, mutations: _mu, compatibility: _co, logs: _l,
  timings: _ti, errorMessage: _e, outputSizeBytes: _o, outputTruncated: _ot, decodedInputSizeBytes: _di,
  decodedInputTruncated: _dt, validationRules: _vr, validationResults: _vs, ...SUMMARY } = RUN;

const envelope = (code: string, message: string) => ({ error: { code, message } });

/** A multipart body's parts, in order: each name with its value, a file's as {name, type, text}. */
async function partsOf(body: unknown): Promise<[string, unknown][]> {
  expect(body).toBeInstanceOf(FormData);
  const parts: [string, unknown][] = [];
  for (const [name, value] of (body as FormData).entries()) {
    if (typeof value === "string") {
      parts.push([name, value]);
    } else {
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(value);
      });
      parts.push([name, { name: value.name, type: value.type, text }]);
    }
  }
  return parts;
}

describe("My Files' calls", () => {
  it("lists the caller's files with a GET (no CSRF header), parsed", async () => {
    api.routes[`GET ${FILES}`] = () => ({ status: 200, body: { files: [FILE] } });

    await expect(client.getTestFiles(GROUP_ID)).resolves.toEqual({ files: [FILE] });
    expect(api.requests[0]?.headers["x-telflo-csrf"]).toBeUndefined();
  });

  it("reports a list that isn't the contract's as unexpected_response", async () => {
    api.routes[`GET ${FILES}`] = () => ({ status: 200, body: { files: [{ ...FILE, sha256: "nope" }] } });

    await expect(client.getTestFiles(GROUP_ID)).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("uploads multipart: displayName, description, file, in that order, with the CSRF header and no content type set by hand", async () => {
    api.routes[`POST ${FILES}`] = () => ({ status: 201, body: { file: FILE } });
    const file = new File(['{"resourceLogs":[]}'], "zq-app-logs.json", { type: "application/json" });

    await expect(client.uploadTestFile(GROUP_ID, { displayName: "zq-app-logs", description: "Checkout logs", file })).resolves.toEqual({
      file: FILE,
    });

    const [request] = api.requests;
    expect(await partsOf(request?.body)).toEqual([
      ["displayName", "zq-app-logs"],
      ["description", "Checkout logs"],
      ["file", { name: "zq-app-logs.json", type: "application/json", text: '{"resourceLogs":[]}' }],
    ]);
    expect(request?.headers["x-telflo-csrf"]).toBeDefined();
    // Never a multipart type set by hand (it would lack the boundary): the
    // browser writes it, and axios's browser adapters drop their default for
    // a FormData body.
    expect(request?.headers["content-type"] ?? "").not.toMatch(/multipart/i);
    // No name or text in the address (ADR 0024).
    expect(request?.url).toBe(FILES);
  });

  it("carries the API's 413 and 415 refusals as their codes and words", async () => {
    const file = new File(["x"], "a.json");
    api.routes[`POST ${FILES}`] = () => ({ status: 413, body: envelope("test_file_too_large", "The file is larger than 10 MiB.") });
    await expect(client.uploadTestFile(GROUP_ID, { displayName: "a", description: "", file })).rejects.toMatchObject({
      code: "test_file_too_large",
      message: "The file is larger than 10 MiB.",
      status: 413,
    });
    api.routes[`POST ${FILES}`] = () => ({
      status: 415,
      body: envelope("test_file_type_unsupported", "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used."),
    });
    await expect(client.uploadTestFile(GROUP_ID, { displayName: "a", description: "", file })).rejects.toMatchObject({
      code: "test_file_type_unsupported",
      status: 415,
    });
  });

  it("saves a sample as a multipart file typed by its format and named as the API names it", async () => {
    api.routes[`POST ${FILES}/samples`] = () => ({ status: 201, body: { file: FILE } });

    await client.saveTestSample(GROUP_ID, { displayName: "zq-sample", text: '{"a":1}', format: "json" });
    await client.saveTestSample(GROUP_ID, { displayName: "zq-lines", text: "one\ntwo", format: "text" });
    await client.saveTestSample(GROUP_ID, { displayName: "zq-kept.ndjson", text: "{}", format: "json" });

    expect(await partsOf(api.requests[0]?.body)).toEqual([
      ["displayName", "zq-sample"],
      ["description", ""],
      ["file", { name: "zq-sample.json", type: "application/json", text: '{"a":1}' }],
    ]);
    expect((await partsOf(api.requests[1]?.body))[2]).toEqual(["file", { name: "zq-lines.log", type: "text/plain", text: "one\ntwo" }]);
    expect((await partsOf(api.requests[2]?.body))[2]?.[1]).toMatchObject({ name: "zq-kept.ndjson" });
    for (const request of api.requests) {
      expect(request.headers["content-type"] ?? "").not.toMatch(/multipart/i);
      expect(request.headers["x-telflo-csrf"]).toBeDefined();
    }
  });

  it("deletes a file by its id, with the CSRF header, resolving undefined on 204", async () => {
    api.routes[`DELETE ${FILES}/${FILE.id}`] = () => ({ status: 204 });

    await expect(client.deleteTestFile(GROUP_ID, FILE.id)).resolves.toBeUndefined();
    expect(api.requests[0]?.headers["x-telflo-csrf"]).toBeDefined();
  });

  it("encodes ids in the path", async () => {
    api.routes[`DELETE ${FILES}/a%2F..%2Fb`] = () => ({ status: 204 });

    await expect(client.deleteTestFile(GROUP_ID, "a/../b")).resolves.toBeUndefined();
  });

  it("reads a file's head (Ruling 43) as its bytes with a GET, never decoded: a UTF-16 head survives", async () => {
    const utf16 = new Uint8Array([0xfe, 0xff, 0x00, 0x7b, 0x00, 0x7d]);
    api.routes[`GET ${FILES}/${FILE.id}/head`] = () => ({ status: 200, bytes: utf16 });

    const bytes = await client.getTestFileHead(GROUP_ID, FILE.id);

    expect([...bytes]).toEqual([...utf16]);
    expect(api.requests[0]?.responseType).toBe("arraybuffer");
    expect(api.requests[0]?.headers["x-telflo-csrf"]).toBeUndefined();
  });

  it("carries a head read's 404, sent as bytes, as its envelope", async () => {
    api.routes[`GET ${FILES}/${FILE.id}/head`] = () => ({
      status: 404,
      body: envelope("test_file_not_found", "Test file not found."),
      envelopeAsBytes: true,
    });

    await expect(client.getTestFileHead(GROUP_ID, FILE.id)).rejects.toMatchObject({ code: "test_file_not_found", status: 404 });
  });
});

describe("the runs' calls", () => {
  const REQUEST = {
    inputFileId: FILE.id,
    pipeline: "logs",
    signal: "logs" as const,
    durationSeconds: 5,
    yaml: "receivers: {}\n",
    collectorVersion: "0.162.0",
  };

  it("queues a run with a JSON body and the CSRF header, parsing the run", async () => {
    api.routes[`POST ${RUNS}`] = () => ({ status: 201, body: { run: RUN } });

    await expect(client.queueTestRun(GROUP_ID, MINE.id, VERSION_ID, REQUEST)).resolves.toEqual({ run: RUN });
    expect(api.requests[0]?.body).toEqual(REQUEST);
    expect(api.requests[0]?.headers["x-telflo-csrf"]).toBeDefined();
  });

  it.each([
    [503, "testing_unavailable", "Testing is unavailable right now. Try again later."],
    [429, "test_run_queue_full", "You have 50 test runs waiting already. Wait for some to finish."],
    [400, "collector_version_retired", "No longer offered. Pick a newer collector version."],
    [400, "collector_version_unknown", "That collector version isn't offered."],
  ])("carries a %i %s refusal as its code and words", async (status, code, message) => {
    api.routes[`POST ${RUNS}`] = () => ({ status, body: envelope(code, message) });

    await expect(client.queueTestRun(GROUP_ID, MINE.id, VERSION_ID, REQUEST)).rejects.toMatchObject({ code, message, status });
  });

  it("carries the rate limit's Retry-After", async () => {
    api.routes[`POST ${RUNS}`] = () => ({
      status: 429,
      body: envelope("test_run_rate_limited", "Too many test runs in the last minute. Try again shortly."),
      headers: { "retry-after": "37" },
    });

    await expect(client.queueTestRun(GROUP_ID, MINE.id, VERSION_ID, REQUEST)).rejects.toMatchObject({
      code: "test_run_rate_limited",
      retryAfterSeconds: 37,
    });
  });

  it("lists the version's runs and reads one, with GETs, parsed", async () => {
    api.routes[`GET ${RUNS}`] = () => ({ status: 200, body: { runs: [SUMMARY] } });
    api.routes[`GET ${RUNS}/${RUN.id}`] = () => ({ status: 200, body: { run: RUN } });

    await expect(client.getTestRuns(GROUP_ID, MINE.id, VERSION_ID)).resolves.toEqual({ runs: [SUMMARY] });
    await expect(client.getTestRun(GROUP_ID, MINE.id, VERSION_ID, RUN.id)).resolves.toEqual({ run: RUN });
    expect(api.requests.map((request) => request.headers["x-telflo-csrf"])).toEqual([undefined, undefined]);
  });

  it("reports a list carrying the run's text (not the contract's summary) as unexpected_response", async () => {
    api.routes[`GET ${RUNS}`] = () => ({ status: 200, body: { runs: [RUN] } });

    await expect(client.getTestRuns(GROUP_ID, MINE.id, VERSION_ID)).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("reads a run's file as its bytes, never decoded: a UTF-16 input survives", async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]);
    api.routes[`GET ${RUNS}/${RUN.id}/files/input`] = () => ({ status: 200, bytes: utf16 });

    const bytes = await client.getTestRunFile(GROUP_ID, MINE.id, VERSION_ID, RUN.id, "input");

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual([...utf16]);
    expect(api.requests[0]?.responseType).toBe("arraybuffer");
  });

  it("reads a file read's refusal, sent as bytes, as its envelope", async () => {
    api.routes[`GET ${RUNS}/${RUN.id}/files/output`] = () => ({
      status: 404,
      body: envelope("test_run_not_found", "This run has no such file."),
      envelopeAsBytes: true,
    });

    await expect(client.getTestRunFile(GROUP_ID, MINE.id, VERSION_ID, RUN.id, "output")).rejects.toMatchObject({
      code: "test_run_not_found",
      message: "This run has no such file.",
      status: 404,
    });
  });

  it("refreshes an expired access token on a file read, whose refusal arrives as bytes, and retries once", async () => {
    let reads = 0;
    api.routes[`GET ${RUNS}/${RUN.id}/files/decoded-input`] = () =>
      ++reads === 1
        ? { status: 401, body: envelope("access_token_expired", "Your access token has expired."), envelopeAsBytes: true }
        : { status: 200, bytes: new Uint8Array([1, 2, 3]) };
    api.routes["POST /api/v1/auth/refresh"] = () => ({ status: 200, body: { user: { id: "u", email: "e@example.com" } } });

    const bytes = await client.getTestRunFile(GROUP_ID, MINE.id, VERSION_ID, RUN.id, "decoded-input");

    expect([...bytes]).toEqual([1, 2, 3]);
    expect(api.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${RUNS}/${RUN.id}/files/decoded-input`,
      "POST /api/v1/auth/refresh",
      `GET ${RUNS}/${RUN.id}/files/decoded-input`,
    ]);
  });
});

describe("the suites' and definitions' calls (D14b detail 19)", () => {
  const SUITES = `/api/v1/organizations/${GROUP_ID}/configurations/${MINE.id}/versions/${VERSION_ID}/test-suites`;
  const SUITE = testSuiteFixture();
  const DEFINITION = testDefinitionFixture();
  const DEFINITIONS = `${SUITES}/${SUITE.id}/definitions`;

  it("lists a version's suites and a suite's definitions with GETs (no CSRF header), parsed", async () => {
    api.routes[`GET ${SUITES}`] = () => ({ status: 200, body: { suites: [SUITE] } });
    api.routes[`GET ${DEFINITIONS}`] = () => ({ status: 200, body: { definitions: [DEFINITION] } });

    await expect(client.getTestSuites(GROUP_ID, MINE.id, VERSION_ID)).resolves.toEqual({ suites: [SUITE] });
    await expect(client.getTestDefinitions(GROUP_ID, MINE.id, VERSION_ID, SUITE.id)).resolves.toEqual({ definitions: [DEFINITION] });
    expect(api.requests.map((request) => request.headers["x-telflo-csrf"])).toEqual([undefined, undefined]);
  });

  it("carries a signal on the suites', definitions' and templates' reads: an aborted one answers request_aborted, as the hang guard needs (D14b Ruling 50)", async () => {
    api.routes[`GET ${SUITES}`] = () => ({ status: 200, body: { suites: [SUITE] } });
    api.routes[`GET ${DEFINITIONS}`] = () => ({ status: 200, body: { definitions: [DEFINITION] } });
    api.routes["GET /api/v1/test-templates"] = () => ({ status: 200, body: { templates: [] } });
    const aborted = new AbortController();
    aborted.abort();
    const signal = aborted.signal;

    await expect(client.getTestSuites(GROUP_ID, MINE.id, VERSION_ID, { signal })).rejects.toMatchObject({ code: client.REQUEST_ABORTED });
    await expect(client.getTestDefinitions(GROUP_ID, MINE.id, VERSION_ID, SUITE.id, { signal })).rejects.toMatchObject({
      code: client.REQUEST_ABORTED,
    });
    await expect(client.getTestTemplates({ signal })).rejects.toMatchObject({ code: client.REQUEST_ABORTED });
    // Unaborted, each answers.
    await expect(client.getTestTemplates()).resolves.toEqual({ templates: [] });
  });

  it("creates, renames and deletes a suite with JSON bodies and the CSRF header; names travel only in the bodies", async () => {
    api.routes[`POST ${SUITES}`] = () => ({ status: 201, body: { suite: SUITE } });
    api.routes[`PATCH ${SUITES}/${SUITE.id}`] = () => ({ status: 200, body: { suite: SUITE } });
    api.routes[`DELETE ${SUITES}/${SUITE.id}`] = () => ({ status: 204 });

    await expect(client.createTestSuite(GROUP_ID, MINE.id, VERSION_ID, { name: SUITE.name, description: "" })).resolves.toEqual({ suite: SUITE });
    await expect(client.updateTestSuite(GROUP_ID, MINE.id, VERSION_ID, SUITE.id, { name: SUITE.name })).resolves.toEqual({ suite: SUITE });
    await expect(client.deleteTestSuite(GROUP_ID, MINE.id, VERSION_ID, SUITE.id)).resolves.toBeUndefined();

    expect(api.requests.map((request) => [request.method, request.body])).toEqual([
      ["POST", { name: SUITE.name, description: "" }],
      ["PATCH", { name: SUITE.name }],
      ["DELETE", undefined],
    ]);
    for (const request of api.requests) {
      expect(request.headers["x-telflo-csrf"]).toBeDefined();
      expect(request.url).not.toContain("zq");
    }
  });

  it("creates and deletes a definition, and reads its input's head as bytes", async () => {
    const request = { inputFileId: testFileFixture().id, name: DEFINITION.name, pipeline: "logs", signal: "logs" as const, durationSeconds: 7 };
    api.routes[`POST ${DEFINITIONS}`] = () => ({ status: 201, body: { definition: DEFINITION } });
    api.routes[`DELETE ${DEFINITIONS}/${DEFINITION.id}`] = () => ({ status: 204 });
    const head = new Uint8Array([0xff, 0xfe, 0x7b, 0x00]);
    api.routes[`GET ${DEFINITIONS}/${DEFINITION.id}/input/head`] = () => ({ status: 200, bytes: head });

    await expect(client.createTestDefinition(GROUP_ID, MINE.id, VERSION_ID, SUITE.id, request)).resolves.toEqual({ definition: DEFINITION });
    await expect(client.deleteTestDefinition(GROUP_ID, MINE.id, VERSION_ID, SUITE.id, DEFINITION.id)).resolves.toBeUndefined();
    const bytes = await client.getTestDefinitionInputHead(GROUP_ID, MINE.id, VERSION_ID, SUITE.id, DEFINITION.id);

    expect([...bytes]).toEqual([...head]);
    expect(api.requests[0]?.body).toEqual(request);
    expect(api.requests[2]?.responseType).toBe("arraybuffer");
  });

  it.each([
    ["a suite", "test_suite_limit_reached", "A version can have at most 100 test suites."],
    ["a definition", "test_definition_limit_reached", "A test suite can have at most 100 test configurations."],
  ])("carries the cap's 409 for %s as its code and words (decision 25)", async (what, code, message) => {
    api.routes[`POST ${SUITES}`] = () => ({ status: 409, body: envelope(code, message) });
    api.routes[`POST ${DEFINITIONS}`] = () => ({ status: 409, body: envelope(code, message) });

    const sending =
      what === "a suite"
        ? client.createTestSuite(GROUP_ID, MINE.id, VERSION_ID, { name: "x" })
        : client.createTestDefinition(GROUP_ID, MINE.id, VERSION_ID, SUITE.id, {
            inputFileId: testFileFixture().id,
            name: "x",
            pipeline: "logs",
            signal: "logs",
            durationSeconds: 5,
          });
    await expect(sending).rejects.toMatchObject({ code, message, status: 409 });
  });
});

describe("the validation pipelines' and rules' calls (D15a detail 24)", () => {
  const PIPELINES = `/api/v1/organizations/${GROUP_ID}/configurations/${MINE.id}/versions/${VERSION_ID}/validation-pipelines`;
  const PIPELINE = validationPipelineFixture();
  const RULE = validationRuleFixture();
  const RULES = `${PIPELINES}/${PIPELINE.id}/rules`;

  it("lists a version's validation pipelines and a pipeline's rules with GETs (no CSRF header), parsed; an aborted read answers request_aborted", async () => {
    api.routes[`GET ${PIPELINES}`] = () => ({ status: 200, body: { validationPipelines: [PIPELINE] } });
    api.routes[`GET ${RULES}`] = () => ({ status: 200, body: { rules: [RULE] } });

    await expect(client.getValidationPipelines(GROUP_ID, MINE.id, VERSION_ID)).resolves.toEqual({ validationPipelines: [PIPELINE] });
    await expect(client.getValidationRules(GROUP_ID, MINE.id, VERSION_ID, PIPELINE.id)).resolves.toEqual({ rules: [RULE] });
    expect(api.requests.map((request) => request.headers["x-telflo-csrf"])).toEqual([undefined, undefined]);

    const aborted = new AbortController();
    aborted.abort();
    await expect(client.getValidationPipelines(GROUP_ID, MINE.id, VERSION_ID, { signal: aborted.signal })).rejects.toMatchObject({
      code: client.REQUEST_ABORTED,
    });
    await expect(client.getValidationRules(GROUP_ID, MINE.id, VERSION_ID, PIPELINE.id, { signal: aborted.signal })).rejects.toMatchObject({
      code: client.REQUEST_ABORTED,
    });
  });

  it("creates and deletes a validation pipeline, and creates, changes and deletes a rule, with JSON bodies and the CSRF header; rule text travels only in the bodies", async () => {
    api.routes[`POST ${PIPELINES}`] = () => ({ status: 201, body: { validationPipeline: PIPELINE } });
    api.routes[`DELETE ${PIPELINES}/${PIPELINE.id}`] = () => ({ status: 204 });
    api.routes[`POST ${RULES}`] = () => ({ status: 201, body: { rule: RULE } });
    api.routes[`PATCH ${RULES}/${RULE.id}`] = () => ({ status: 200, body: { rule: RULE } });
    api.routes[`DELETE ${RULES}/${RULE.id}`] = () => ({ status: 204 });
    const rule = { kind: "not_contains_text" as const, target: "output" as const, pattern: "zq-secret-token", name: "zq-no-secrets", description: "" };

    await expect(client.createValidationPipeline(GROUP_ID, MINE.id, VERSION_ID, { pipeline: "logs" })).resolves.toEqual({
      validationPipeline: PIPELINE,
    });
    await expect(client.createValidationRule(GROUP_ID, MINE.id, VERSION_ID, PIPELINE.id, rule)).resolves.toEqual({ rule: RULE });
    await expect(client.updateValidationRule(GROUP_ID, MINE.id, VERSION_ID, PIPELINE.id, RULE.id, rule)).resolves.toEqual({ rule: RULE });
    await expect(client.deleteValidationRule(GROUP_ID, MINE.id, VERSION_ID, PIPELINE.id, RULE.id)).resolves.toBeUndefined();
    await expect(client.deleteValidationPipeline(GROUP_ID, MINE.id, VERSION_ID, PIPELINE.id)).resolves.toBeUndefined();

    expect(api.requests.map((request) => [request.method, request.body])).toEqual([
      ["POST", { pipeline: "logs" }],
      ["POST", rule],
      ["PATCH", rule],
      ["DELETE", undefined],
      ["DELETE", undefined],
    ]);
    for (const request of api.requests) {
      expect(request.headers["x-telflo-csrf"]).toBeDefined();
      expect(request.url).not.toContain("zq");
    }
  });

  it.each([
    [400, "validation_rule_invalid", 'OTTL syntax error: unexpected token "prod'],
    [503, "rules_unavailable", "Rules can't be checked right now. Try again shortly."],
    [429, "validation_rule_rate_limited", "Too many rule checks. Try again in a minute."],
    [409, "validation_rule_limit_reached", "A validation pipeline can have at most 200 rules."],
  ])("carries a rule save's %i as its code and words", async (status, code, message) => {
    api.routes[`POST ${RULES}`] = () => ({ status, body: envelope(code, message) });

    await expect(
      client.createValidationRule(GROUP_ID, MINE.id, VERSION_ID, PIPELINE.id, { kind: "ottl", target: "output", ottl: { context: "log", quantifier: "all", condition: "x" } }),
    ).rejects.toMatchObject({ code, message, status });
  });

  it("carries a 400 validation_rule_invalid's details as the envelope gives them (Ruling 46), and none when it gives none", async () => {
    const save = () =>
      client.createValidationRule(GROUP_ID, MINE.id, VERSION_ID, PIPELINE.id, {
        kind: "ottl",
        target: "output",
        ottl: { context: "log", quantifier: "distinct", condition: "true", expression: "x(", count: { operator: "lte", value: 1 } },
      });
    const details = {
      problems: [
        { field: "ottl.expression", message: "OTTL syntax error: zq" },
        { field: "ottl.count.value2", message: "Only between has a second value." },
      ],
    };
    api.routes[`POST ${RULES}`] = () => ({
      status: 400,
      body: { error: { code: "validation_rule_invalid", message: "OTTL syntax error: zq", details } },
    });

    const refused = await save().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(client.ApiError);
    expect(refused).toMatchObject({ code: "validation_rule_invalid", message: "OTTL syntax error: zq", status: 400, details });

    api.routes[`POST ${RULES}`] = () => ({ status: 400, body: envelope("validation_rule_invalid", "OTTL syntax error: zq") });
    const bare = await save().catch((error: unknown) => error);
    expect(bare).toMatchObject({ code: "validation_rule_invalid", status: 400 });
    expect((bare as InstanceType<typeof client.ApiError>).details).toBeUndefined();
  });
});

describe("the product admin's template writes (D14b Task 8)", () => {
  const TEMPLATES = "/api/v1/test-templates";
  const TEMPLATE = {
    id: "0199f200-0000-7000-8000-000000000001",
    name: "zq-otlp-traces",
    description: "",
    receiverType: "otlp",
    signal: "traces" as const,
    fileName: "zq-otlp-traces.json",
    contentType: "application/json",
    sizeBytes: 2,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
  };

  it("uploads multipart: name, description, receiverType, signal, file, in that order, with the CSRF header and no content type set by hand; no name in the address", async () => {
    api.routes[`POST ${TEMPLATES}`] = () => ({ status: 201, body: { template: TEMPLATE } });
    const file = new File(["{}"], "zq-otlp-traces.json", { type: "application/json" });

    await expect(
      client.createTestTemplate({ name: "zq-otlp-traces", description: "zq-about", receiverType: "otlp", signal: "traces", file }),
    ).resolves.toEqual({ template: TEMPLATE });

    const [request] = api.requests;
    expect(await partsOf(request?.body)).toEqual([
      ["name", "zq-otlp-traces"],
      ["description", "zq-about"],
      ["receiverType", "otlp"],
      ["signal", "traces"],
      ["file", { name: "zq-otlp-traces.json", type: "application/json", text: "{}" }],
    ]);
    expect(request?.headers["x-telflo-csrf"]).toBeDefined();
    expect(request?.headers["content-type"] ?? "").not.toMatch(/multipart/i);
    expect(request?.url).toBe(TEMPLATES);
  });

  it("carries the API's 413 and 415 refusals as their codes and words, and a non-admin's 403", async () => {
    const upload = { name: "a", description: "", receiverType: "otlp", signal: "logs" as const, file: new File(["x"], "a.json") };
    api.routes[`POST ${TEMPLATES}`] = () => ({ status: 413, body: envelope("test_file_too_large", "The file is larger than 10 MiB.") });
    await expect(client.createTestTemplate(upload)).rejects.toMatchObject({
      code: "test_file_too_large",
      message: "The file is larger than 10 MiB.",
      status: 413,
    });
    api.routes[`POST ${TEMPLATES}`] = () => ({
      status: 415,
      body: envelope("test_file_type_unsupported", "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used."),
    });
    await expect(client.createTestTemplate(upload)).rejects.toMatchObject({ code: "test_file_type_unsupported", status: 415 });
    api.routes[`POST ${TEMPLATES}`] = () => ({ status: 403, body: envelope("product_admin_required", "Only product admins can do that.") });
    await expect(client.createTestTemplate(upload)).rejects.toMatchObject({ code: "product_admin_required", status: 403 });
  });

  it("changes a template's metadata with a JSON PATCH and deletes it, each by its id alone, encoded, with the CSRF header", async () => {
    api.routes[`PATCH ${TEMPLATES}/${TEMPLATE.id}`] = () => ({ status: 200, body: { template: TEMPLATE } });
    api.routes[`DELETE ${TEMPLATES}/a%2F..%2Fb`] = () => ({ status: 204 });

    await expect(client.updateTestTemplate(TEMPLATE.id, { name: "zq-renamed", signal: "logs" })).resolves.toEqual({ template: TEMPLATE });
    await expect(client.deleteTestTemplate("a/../b")).resolves.toBeUndefined();

    expect(api.requests[0]?.body).toEqual({ name: "zq-renamed", signal: "logs" });
    for (const request of api.requests) {
      expect(request.headers["x-telflo-csrf"]).toBeDefined();
      expect(request.url).not.toContain("zq");
    }
  });
});

describe("the regex library's calls (D15b decision 8)", () => {
  const TEST_REGEXES = "/api/v1/test-regexes";
  const ENTRY = {
    id: "0199f300-0000-7000-8000-000000000001",
    name: "zq-Email Address",
    category: "zq-PII",
    description: null,
    regex: "zq[a-z]+@[a-z]+",
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
  };

  it("lists the library with a GET (no CSRF header), parsed; an aborted read answers request_aborted", async () => {
    api.routes[`GET ${TEST_REGEXES}`] = () => ({ status: 200, body: { testRegexes: [ENTRY] } });

    await expect(client.getTestRegexes()).resolves.toEqual({ testRegexes: [ENTRY] });
    expect(api.requests[0]?.headers["x-telflo-csrf"]).toBeUndefined();

    const aborted = new AbortController();
    aborted.abort();
    await expect(client.getTestRegexes({ signal: aborted.signal })).rejects.toMatchObject({ code: client.REQUEST_ABORTED });
  });

  it("creates, changes and deletes an entry with JSON bodies and the CSRF header, each by its id alone, encoded; the entry's text travels only in the bodies", async () => {
    api.routes[`POST ${TEST_REGEXES}`] = () => ({ status: 201, body: { testRegex: ENTRY } });
    api.routes[`PATCH ${TEST_REGEXES}/${ENTRY.id}`] = () => ({ status: 200, body: { testRegex: ENTRY } });
    api.routes[`DELETE ${TEST_REGEXES}/a%2F..%2Fb`] = () => ({ status: 204 });
    const request = { name: "zq-Email Address", category: "zq-PII", description: null, regex: "zq[a-z]+@[a-z]+" };

    await expect(client.createTestRegex(request)).resolves.toEqual({ testRegex: ENTRY });
    await expect(client.updateTestRegex(ENTRY.id, { name: "zq-renamed", regex: "zq\\d+" })).resolves.toEqual({ testRegex: ENTRY });
    await expect(client.deleteTestRegex("a/../b")).resolves.toBeUndefined();

    expect(api.requests.map((seen) => [seen.method, seen.body])).toEqual([
      ["POST", request],
      ["PATCH", { name: "zq-renamed", regex: "zq\\d+" }],
      ["DELETE", undefined],
    ]);
    for (const seen of api.requests) {
      expect(seen.headers["x-telflo-csrf"]).toBeDefined();
      expect(seen.url).not.toContain("zq");
    }
  });

  it("carries the refusals as their codes and words, test_regex_invalid's problems as its details", async () => {
    const details = { problems: [{ field: "regex", message: "Invalid regex: zq" }] };
    const refusals: [number, string, string, unknown][] = [
      [400, "test_regex_invalid", "Invalid regex: zq", details],
      [409, "test_regex_name_taken", "A regex with that name already exists.", undefined],
      [429, "validation_rule_rate_limited", "Too many rule checks in the last minute. Try again shortly.", undefined],
      [503, "rules_unavailable", "Rules can't be checked right now. Try again shortly.", undefined],
      [403, "product_admin_required", "Only a product admin can do that.", undefined],
    ];
    for (const [status, code, message, given] of refusals) {
      api.routes[`POST ${TEST_REGEXES}`] = () => ({
        status,
        body: { error: { code, message, ...(given === undefined ? {} : { details: given }) } },
      });
      const refused = await client.createTestRegex({ name: "a", category: "b", regex: "c" }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(client.ApiError);
      expect(refused).toMatchObject({ code, message, status, details: given });
    }
  });
});
