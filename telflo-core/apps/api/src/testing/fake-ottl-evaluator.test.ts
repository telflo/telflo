import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FAKE_OTTL_EVALUATOR_MARKERS,
  FAKE_OTTL_EVALUATOR_UNDEFINED_FUNCTIONS,
  fakeOttlEvaluatorMarker,
  startFakeOttlEvaluator,
  type FakeOttlEvaluator,
  type FakeOttlEvaluatorFault,
} from "./fake-ottl-evaluator.js";

// The fake OTTL evaluator's own contract checks (D15a Task 5; plan Preflight
// ruling 28): it must catch a request that breaks
// services/ottl-evaluator/openapi.yaml, and a reply of its own that does, or
// the client's and the API's tests against it prove nothing; and it must
// answer by the request, as the browser tests rely on. These tests send raw
// requests, shaped as the client's are, then broken. D25 Task 3 added the
// lint's (POST /ottl/v1/lint).

let fake: FakeOttlEvaluator;

beforeAll(async () => {
  fake = await startFakeOttlEvaluator();
});

afterEach(() => {
  expect(fake.takeViolations()).toEqual([]);
  fake.takeRequests();
});

afterAll(async () => {
  await fake.close();
});

const RULE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01";

function post(path: string, body: unknown, headers: Record<string, string> = {}, raw?: string): Promise<Response> {
  return fetch(`${fake.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

const output = (text: string, truncated = false) => ({ base64: Buffer.from(text).toString("base64"), truncated });

const evaluate = (rules: unknown[], overrides: Record<string, unknown> = {}) =>
  post("/ottl/v1/evaluate", { signal: "logs", output: output('{"resourceLogs":[]}'), log: "", rules, ...overrides });

const validate = (rule: unknown, signal = "logs") => post("/ottl/v1/validate", { signal, rule });

const ottl = (condition: string, extra: Record<string, unknown> = {}) => ({
  id: RULE_ID,
  kind: "ottl",
  target: "output",
  ottl: { context: "log", quantifier: "all", condition, ...extra },
});

const text = (kind: string, pattern: string, target = "output", id = RULE_ID) => ({ id, kind, target, pattern });

const lint = (body: Record<string, unknown>) => post("/ottl/v1/lint", body);

describe("the fake ottl-evaluator's request validation", () => {
  it("accepts an evaluate request that keeps the contract, and records it, the output's base64 as its size and SHA-256", async () => {
    const response = await evaluate([ottl("true")], { output: output("abc", true) });

    expect(response.status).toBe(200);
    expect(fake.takeRequests()).toEqual([
      {
        operation: "evaluate",
        body: {
          signal: "logs",
          output: {
            base64: { sizeBytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
            truncated: true,
          },
          log: "",
          rules: [ottl("true")],
        },
      },
    ]);
  });

  it("catches what the contract refuses, answering 400 as the real evaluator does", async () => {
    const cases: Array<[unknown[], Record<string, unknown>]> = [
      // The tester's bytesOnDisk isn't the contract's Output.
      [[ottl("true")], { output: { ...output("x"), bytesOnDisk: 1 } }],
      // An empty pattern, a retired kind, an OTTL rule on stderr.
      [[text("contains_text", "")], {}],
      [[text("json_path", "$.x")], {}],
      [[{ ...ottl("true"), target: "stderr" }], {}],
      // A condition sent as null, a count that isn't an integer.
      [[ottl("true", { condition: null })], {}],
      [[ottl("true", { quantifier: "count", count: { operator: "eq", value: 2.5 } })], {}],
      // No rules, a field it doesn't know, no log.
      [[], {}],
      [[ottl("true")], { runId: "x" }],
      [[ottl("true")], { log: undefined }],
    ];
    for (const [rules, overrides] of cases) {
      const response = await evaluate(rules, overrides);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(fake.takeViolations()).toEqual([expect.stringContaining("evaluate request body")]);
    }
  });

  it("catches a repeated rule id, and base64 that isn't standard or decodes past 10 MiB", async () => {
    const twice = await evaluate([text("contains_text", "a"), text("contains_text", "b")]);
    expect(twice.status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("/rules repeats an id")]);

    const unpadded = await evaluate([ottl("true")], { output: { base64: "YWJj=", truncated: false } });
    expect(unpadded.status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("/output/base64 isn't standard base64")]);

    const large = await evaluate([ottl("true")], { output: { base64: Buffer.alloc(10_485_761).toString("base64"), truncated: false } });
    expect(large.status).toBe(400);
    expect(fake.takeViolations()).toEqual(
      expect.arrayContaining([expect.stringContaining("/output/base64 is larger than 10 MiB decoded")]),
    );
  });

  it("catches a validate request with an id, or without its rule", async () => {
    for (const body of [{ signal: "logs", rule: text("contains_text", "x") }, { signal: "logs" }]) {
      const response = await post("/ottl/v1/validate", body);
      expect(response.status).toBe(400);
      expect(fake.takeViolations()).toEqual([expect.stringContaining("validate request body")]);
    }
  });

  it("catches a body that isn't JSON, the wrong Content-Type, and a validate body over 64 KiB", async () => {
    expect((await post("/ottl/v1/evaluate", undefined, {}, "{not json")).status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("isn't JSON")]);

    expect((await evaluate([ottl("true")], {})).status).toBe(200);
    expect((await post("/ottl/v1/evaluate", { signal: "logs" }, { "content-type": "text/plain" })).status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("Content-Type")]);

    const response = await validate({ kind: "contains_text", target: "output", pattern: "x".repeat(70_000) });
    expect(response.status).toBe(413);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("larger than 65536 bytes")]);
  });

  it("catches the secret sent without the Bearer scheme, and answers 401 with WWW-Authenticate; a wrong one is a documented 401", async () => {
    const bare = await post("/ottl/v1/validate", {}, { authorization: fake.secret });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toBe("Bearer");
    expect(fake.takeViolations()).toEqual([expect.stringContaining("no Authorization: Bearer header")]);

    const wrong = await post("/ottl/v1/validate", {}, { authorization: "Bearer not-the-fake-secret-not-the-fake-secret" });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: { code: "unauthorized", message: "A valid secret is required." } });
    expect(fake.takeRequests()).toEqual([]);
  });

  it("catches a route the file doesn't document (/ottl/v1/functions is gone), and a query", async () => {
    const functions = await fetch(`${fake.url}/ottl/v1/functions`, { headers: { authorization: `Bearer ${fake.secret}` } });
    expect(functions.status).toBe(404);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("the route isn't documented")]);

    expect((await post("/ottl/v1/evaluate?debug=1", { signal: "logs", output: null, log: "", rules: [ottl("true")] })).status).toBe(200);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("has a query")]);
  });

  it("answers /health without the secret, with its OTTL version; reset while set down", async () => {
    const response = await fetch(`${fake.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", ottlVersion: "v0.162.0" });

    fake.setHealth("down");
    try {
      await expect(fetch(`${fake.url}/health`)).rejects.toThrow();
    } finally {
      fake.setHealth("up");
    }
  });
});

describe("the fake ottl-evaluator's answers by the request (Preflight ruling 28)", () => {
  it("names its markers", () => {
    expect(FAKE_OTTL_EVALUATOR_MARKERS).toEqual(["invalid", "fail", "error", "busy", "unavailable"]);
    expect(fakeOttlEvaluatorMarker("fail")).toBe("fake-ottl-evaluator: fail");
  });

  it("passes every rule by default, in the request's order, each by its id", async () => {
    const rules = [text("contains_text", "a", "output", `${RULE_ID}-1`), text("not_contains_regex", "b", "stderr", `${RULE_ID}-2`)];
    const body = (await (await evaluate(rules)).json()) as { ottlVersion: string; results: Array<Record<string, unknown>> };

    expect(body).toEqual({
      ottlVersion: "v0.162.0",
      results: rules.map((rule) => ({ id: rule.id, passed: true, error: null, advisory: null, detail: null })),
    });
  });

  it("fails a rule marked `fail` with its kind's detail, the marker inside an OTTL string literal", async () => {
    const marker = fakeOttlEvaluatorMarker("fail");
    const rules = [
      text("contains_text", marker, "stderr", "r1"),
      text("not_contains_text", marker, "output", "r2"),
      text("not_contains_regex", marker, "stderr", "r3"),
      { ...ottl(`body == "${marker}"`), id: "r4" },
      { ...ottl("true", { quantifier: "distinct", expression: `Concat([body, "${marker}"], "")`, count: { operator: "lte", value: 0 } }), id: "r5" },
    ];
    const body = (await (await evaluate(rules, { log: "two\nlines" })).json()) as { results: Array<{ passed: boolean; detail: { kind: string } }> };

    expect(body.results.map((result) => result.passed)).toEqual([false, false, false, false, false]);
    expect(body.results.map((result) => result.detail.kind)).toEqual([
      "no_match",
      "unexpected_match",
      "unexpected_match",
      "record_mismatch",
      "distinct_mismatch",
    ]);
    expect(body.results[0]?.detail).toEqual({ kind: "no_match", source: "stderr", searchedCharacters: 9 });
  });

  it("lists an OTTL rule's misses as the evaluator does: all and any false records, none matches, count none", async () => {
    const marker = fakeOttlEvaluatorMarker("fail");
    const rules = ["all", "any", "none"].map((quantifier, index) => ({ ...ottl(`body == "${marker}"`, { quantifier }), id: `r${index}` }));
    rules.push({ ...ottl(`body == "${marker}"`, { quantifier: "count", count: { operator: "eq", value: 2 } }), id: "r3" });
    const body = (await (await evaluate(rules)).json()) as { results: Array<{ detail: Record<string, unknown> }> };

    const falseMiss = { kind: "record_mismatch", context: "log", totalCount: 1, matchedCount: 0, missCount: 1, misses: [{ index: 0, reason: "condition evaluated to false", snippet: "{}" }] };
    expect(body.results.map((result) => result.detail)).toEqual([
      falseMiss,
      falseMiss,
      { kind: "record_mismatch", context: "log", totalCount: 1, matchedCount: 1, missCount: 1, misses: [{ index: 0, reason: "unexpected match", snippet: "{}" }] },
      { kind: "record_mismatch", context: "log", totalCount: 1, matchedCount: 0, missCount: 0, misses: [] },
    ]);
  });

  it("errs a rule marked `error` or `invalid`, in the evaluator's words for each", async () => {
    const rules = [
      { ...ottl(`body == "${fakeOttlEvaluatorMarker("error")}"`), id: "r1" },
      { ...ottl(`body == "${fakeOttlEvaluatorMarker("invalid")}"`), id: "r2" },
      text("contains_regex", fakeOttlEvaluatorMarker("invalid"), "output", "r3"),
    ];
    const body = (await (await evaluate(rules)).json()) as { results: Array<{ passed: boolean; error: string; detail: null }> };

    expect(body.results.map((result) => [result.passed, result.detail])).toEqual([
      [false, null],
      [false, null],
      [false, null],
    ]);
    expect(body.results[0]?.error).toBe("Not checked: the rules took longer than 20 s to check.");
    expect(body.results[1]?.error).toMatch(/^OTTL syntax error: /);
    expect(body.results[2]?.error).toMatch(/^Invalid regex: /);
  });

  it("answers the whole request 503 evaluator_busy (Retry-After 1) or 500 for `busy` and `unavailable`", async () => {
    const busy = await evaluate([text("contains_text", "x", "output", "r1"), { ...ottl(`body == "${fakeOttlEvaluatorMarker("busy")}"`), id: "r2" }]);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(await busy.json()).toMatchObject({ error: { code: "evaluator_busy" } });

    const down = await validate({ kind: "contains_text", target: "output", pattern: fakeOttlEvaluatorMarker("unavailable") });
    expect(down.status).toBe(500);
    expect(await down.json()).toMatchObject({ error: { code: "internal_error" } });
  });

  it("adds the truncation advisory to an output rule's result when the output was cut", async () => {
    const body = (await (
      await evaluate([text("contains_text", "a", "output", "r1"), text("contains_text", "a", "stderr", "r2")], { output: output("x", true) })
    ).json()) as { results: Array<{ advisory: string | null }> };
    expect(body.results.map((result) => result.advisory)).toEqual(["Only the first 10 MiB of the output was checked (R-006).", null]);
  });

  it("validates: valid by default; an `invalid` marker's field and words; a context its signal doesn't allow, in the evaluator's words", async () => {
    expect(await (await validate({ kind: "contains_regex", target: "stderr", pattern: "ERROR" })).json()).toEqual({
      valid: true,
      ottlVersion: "v0.162.0",
    });
    const { id: _id, ...rule } = ottl("true", { context: "datapoint", expression: `"${fakeOttlEvaluatorMarker("invalid")}"`, quantifier: "distinct" });
    expect(await (await validate(rule, "logs")).json()).toEqual({
      valid: false,
      problems: [
        { field: "ottl.context", message: 'A logs rule can\'t use the "datapoint" context: use log, resource or scope.' },
        { field: "ottl.expression", message: expect.stringMatching(/^OTTL syntax error: /) },
      ],
      ottlVersion: "v0.162.0",
    });
  });
});

describe("the fake ottl-evaluator's lint (D25 Task 3)", () => {
  it("accepts a lint the contract takes and records it as lint; catches one it refuses, answering 400", async () => {
    expect((await lint({ context: "log", conditions: ["true"], statements: [], valueExpressions: ["body"] })).status).toBe(200);
    expect(fake.takeRequests()).toEqual([
      { operation: "lint", body: { context: "log", conditions: ["true"], statements: [], valueExpressions: ["body"] } },
    ]);
    for (const body of [
      { context: "trace", conditions: ["true"] },
      { context: "log" },
      { context: "log", conditions: [] },
      { context: "log", conditions: ["x".repeat(8193)] },
      { context: "log", conditions: ["true"], yaml: "a: 1" },
    ]) {
      expect((await lint(body)).status).toBe(400);
      expect(fake.takeViolations()).toEqual([expect.stringContaining("lint request body")]);
    }
  });

  it("answers each text by its markers in the evaluator's order, and a transform-only function as undefined, echoing no text", async () => {
    const response = await lint({
      context: "datapoint",
      valueExpressions: ["attributes[\"route\"]"],
      statements: ["convert_sum_to_gauge()", "set(attributes[\"a\"], \"b\")"],
      conditions: [`name == "${fakeOttlEvaluatorMarker("invalid")}"`],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ottlVersion: "v0.162.0",
      items: [
        { kind: "condition", index: 0, valid: false, error: expect.stringMatching(/^OTTL syntax error: /) },
        { kind: "statement", index: 0, valid: false, error: 'OTTL syntax error: undefined function "convert_sum_to_gauge"' },
        { kind: "statement", index: 1, valid: true },
        { kind: "valueExpression", index: 0, valid: true },
      ],
    });
    expect(FAKE_OTTL_EVALUATOR_UNDEFINED_FUNCTIONS.size).toBe(12);
  });

  it("answers the whole lint 503 or 500 for `busy` and `unavailable`, and takes the faults", async () => {
    expect((await lint({ context: "log", conditions: ["true", `body == "${fakeOttlEvaluatorMarker("busy")}"`] })).status).toBe(503);
    expect((await lint({ context: "log", statements: [`set(body, "${fakeOttlEvaluatorMarker("unavailable")}")`] })).status).toBe(500);
    const kindsOf = async () =>
      ((await (await lint({ context: "log", conditions: ["true", "false"] })).json()) as { items: Array<{ kind: string; index: number }> }).items.map(
        ({ kind, index }) => `${kind}:${index}`,
      );
    fake.nextFault("missing_result");
    expect(await kindsOf()).toEqual(["condition:0"]);
    fake.nextFault("extra_result");
    expect(await kindsOf()).toEqual(["condition:0", "condition:1", "statement:199"]);
    fake.nextFault("duplicate_result");
    expect(await kindsOf()).toEqual(["condition:0", "condition:0"]);
    fake.nextFault("malformed_reply");
    expect(await (await lint({ context: "log", conditions: ["true"] })).json()).toEqual({ ottlVersion: "v0.162.0", items: [{ kind: "condition", index: 0 }] });
    expect(fake.takeViolations()).toEqual([expect.stringContaining("lint reply 200 body")]);
    fake.nextFault("evaluator_busy");
    expect((await lint({ context: "log", conditions: ["true"] })).status).toBe(503);
  });
});

describe("the fake ottl-evaluator's faults (nextFault, a queue)", () => {
  it.each<[FakeOttlEvaluatorFault, number, string]>([
    ["error_500", 500, "internal_error"],
    ["evaluator_busy", 503, "evaluator_busy"],
    ["invalid_request", 400, "invalid_request"],
    ["payload_too_large", 413, "payload_too_large"],
  ])("answers %s once, as documented, with no violation", async (fault, status, code) => {
    fake.nextFault(fault);
    const response = await evaluate([ottl("true")]);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });

    expect((await evaluate([ottl("true")])).status).toBe(200);
  });

  it("takes queued faults in order, one per request, validate's too", async () => {
    fake.nextFault("evaluator_busy");
    fake.nextFault("error_500");
    expect((await validate({ kind: "contains_text", target: "output", pattern: "x" })).status).toBe(503);
    expect((await evaluate([ottl("true")])).status).toBe(500);
    expect((await evaluate([ottl("true")])).status).toBe(200);
  });

  it("drops, adds or repeats a result within the file's shapes: no violation", async () => {
    const rules = [text("contains_text", "a", "output", "r1"), text("contains_text", "b", "output", "r2")];
    const idsOf = async () => ((await (await evaluate(rules)).json()) as { results: Array<{ id: string }> }).results.map((result) => result.id);

    fake.nextFault("missing_result");
    expect(await idsOf()).toEqual(["r1"]);
    fake.nextFault("extra_result");
    expect(await idsOf()).toEqual(["r1", "r2", "not-a-rule-it-was-asked-for"]);
    fake.nextFault("duplicate_result");
    expect(await idsOf()).toEqual(["r1", "r1"]);
  });

  it("catches its own malformed reply as a violation, at evaluate and at validate", async () => {
    fake.nextFault("malformed_reply");
    const evaluated = (await (await evaluate([ottl("true")])).json()) as { results: Array<Record<string, unknown>> };
    expect(evaluated.results[0]).not.toHaveProperty("passed");
    expect(fake.takeViolations()).toEqual([expect.stringContaining("evaluate reply 200 body")]);

    fake.nextFault("malformed_reply");
    expect(await (await validate({ kind: "contains_text", target: "output", pattern: "x" })).json()).not.toHaveProperty("valid");
    expect(fake.takeViolations()).toEqual([expect.stringContaining("validate reply 200 body")]);
  });

  it("drops the faults not yet taken on clearFaults(), so one test's leftovers don't answer the next's requests", async () => {
    fake.nextFault("evaluator_busy");
    fake.nextFault("error_500");
    fake.clearFaults();
    expect((await evaluate([ottl("true")])).status).toBe(200);
    expect((await validate({ kind: "contains_text", target: "output", pattern: "x" })).status).toBe(200);
  });

  it("resets the connection", async () => {
    fake.nextFault("reset");
    await expect(evaluate([ottl("true")])).rejects.toThrow();
  });
});

describe("the fake ottl-evaluator's close", () => {
  it("rejects while a violation is unread, so a test that forgets to look still fails", async () => {
    const own = await startFakeOttlEvaluator();
    await fetch(`${own.url}/ottl/v1/evaluate`, { method: "POST", body: "{}" });

    await expect(own.close()).rejects.toThrow(/contract violations no test read/);
  });

  it("ends a request it holds (hang) when it closes", async () => {
    const own = await startFakeOttlEvaluator();
    own.nextFault("hang");
    const pending = fetch(`${own.url}/ottl/v1/validate`, {
      method: "POST",
      headers: { authorization: `Bearer ${own.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ signal: "logs", rule: { kind: "contains_text", target: "output", pattern: "x" } }),
    });
    // Wait until the fake has read it (the request is then recorded): on that condition, since the request
    // crosses a real socket and no count of event-loop turns bounds it, with a hang guard under vitest's 5 s
    // (D23-2 Ruling 153).
    let received = 0;
    await vi.waitFor(
      () => {
        received += own.takeRequests().length;
        if (received === 0) throw new Error("the fake hasn't read the request yet");
      },
      { timeout: 4_000, interval: 1 },
    );
    expect(received).toBe(1);

    await own.close();
    await expect(pending).rejects.toThrow();
  });
});

describe("the fake ottl-evaluator's options", () => {
  it("listens on the port it is given, as the browser tests' does (28089)", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const own = await startFakeOttlEvaluator({ port });
    expect(own.url).toBe(`http://127.0.0.1:${port}`);
    await own.close();
  });

  it("refuses to start on a port that is taken, rather than hanging", async () => {
    const port = Number(new URL(fake.url).port);
    await expect(startFakeOttlEvaluator({ port })).rejects.toThrow(/EADDRINUSE/);
  });

  it("tells onViolation each violation as it records it, and still keeps it for takeViolations", async () => {
    const told: string[] = [];
    const own = await startFakeOttlEvaluator({ onViolation: (message) => told.push(message) });
    await fetch(`${own.url}/ottl/v1/evaluate`, { method: "POST", body: "{}" });

    expect(told).toEqual([expect.stringContaining("no Authorization: Bearer header")]);
    expect(own.takeViolations()).toEqual(told);
    await own.close();
  });
});
