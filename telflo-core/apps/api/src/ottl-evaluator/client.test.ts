import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ValidationRuleResultSchema } from "@telflo/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeOttlEvaluatorMarker, startFakeOttlEvaluator, type FakeOttlEvaluator } from "../testing/fake-ottl-evaluator.js";
import {
  createOttlEvaluatorClient,
  MAX_OTTL_EVALUATOR_LINT_REPLY_BYTES,
  MAX_OTTL_EVALUATOR_REPLY_BYTES,
  OTTL_EVALUATOR_EVALUATE_TIMEOUT_MS,
  OTTL_EVALUATOR_HEALTH_TIMEOUT_MS,
  OTTL_EVALUATOR_LINT_TIMEOUT_MS,
  OTTL_EVALUATOR_VALIDATE_TIMEOUT_MS,
  type EvaluateRulesRequest,
  type EvaluateRulesResult,
  type LintTextsResult,
  type OttlEvaluatorClient,
  type OttlEvaluatorClientLog,
  type OttlEvaluatorRule,
  type ValidateRuleResult,
} from "./client.js";

// The platform's client for the OTTL evaluator (D15a decisions 2, 3 and 6,
// detail 27; plan Preflight rulings 5, 9, 11 and 14; Ruling 33), against the
// OpenAPI-checked fake, and against a hand-made fetch for what the fake
// can't be pushed to answer.
//
// The first block is the client's 17 cases. What a rule's shape allows is
// the evaluator's to check, for every rule, at Save and at a run alike:
// those checks are services/ottl-evaluator's Go tests
// (internal/rules/check_test.go; the records' unwrap in output_test.go), and
// their cases here test the client's half: it sends the rule as it is, and
// passes the evaluator's answer for that rule through. D25 Task 3 added
// lint's block.

let fake: FakeOttlEvaluator;
let client: OttlEvaluatorClient;

beforeAll(async () => {
  fake = await startFakeOttlEvaluator();
  client = createOttlEvaluatorClient({ url: `${fake.url}/`, secret: fake.secret });
});

afterEach(() => {
  vi.useRealTimers();
  expect(fake.takeViolations()).toEqual([]);
  fake.takeRequests();
});

afterAll(async () => {
  await fake.close();
});

/** A rule id, as the platform's are (UUIDs). */
const ruleId = (n: number): string => `0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b${String(n).padStart(2, "0")}`;

/** An OTTL rule over log records. */
function ottlRule(n: number, ottl: Record<string, unknown> = {}): OttlEvaluatorRule {
  return {
    id: ruleId(n),
    kind: "ottl",
    target: "output",
    ottl: { context: "log", quantifier: "all", condition: 'body == "hello"', ...ottl } as OttlEvaluatorRule["ottl"],
  };
}

const textRule = (n: number, kind: OttlEvaluatorRule["kind"], pattern: string, target: "output" | "stderr" = "output"): OttlEvaluatorRule => ({
  id: ruleId(n),
  kind,
  target,
  pattern,
});

const OUTPUT = Buffer.from('{"resourceLogs":[]}');

function evaluation(rules: OttlEvaluatorRule[], overrides: Partial<EvaluateRulesRequest> = {}): EvaluateRulesRequest {
  return { signal: "logs", output: { base64: OUTPUT, truncated: false }, log: "", rules, ...overrides };
}

/** The bodies the fake read since the last call. */
function sentBodies(): Array<Record<string, unknown>> {
  return fake.takeRequests().map((request) => request.body as Record<string, unknown>);
}

/** A result that passed, as the evaluator answers it. */
const passedResult = (id: string) => ({ id, passed: true, error: null, advisory: null, detail: null });

/** A fetch that answers `response` and records what it was asked. */
function answering(response: (init: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return response(init);
  }) as unknown as typeof fetch;
  return { seen, doFetch };
}

/** A 200 whose body is `body` as JSON. */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function handMade(doFetch: typeof fetch, log?: OttlEvaluatorClientLog, maxReplyBytes?: number): OttlEvaluatorClient {
  return createOttlEvaluatorClient({
    url: "http://evaluator.invalid",
    secret: "s".repeat(32),
    fetch: doFetch,
    ...(log === undefined ? {} : { log }),
    ...(maxReplyBytes === undefined ? {} : { maxReplyBytes }),
  });
}

type LogLine = { details: Record<string, unknown>; message: string };

function recordingLog(): OttlEvaluatorClientLog & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  return { lines, error: (details, message) => lines.push({ details, message }) };
}

/** A fetch that never answers until its signal aborts, then rejects as fetch does. */
function neverAnswering(): { doFetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const doFetch = ((_url: string, init: RequestInit) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }) as unknown as typeof fetch;
  return { doFetch, calls: () => calls };
}

/** The address of a server that just closed: nothing listens there. */
async function closedUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function evaluated(result: EvaluateRulesResult) {
  if (result.kind !== "evaluated") throw new Error(`expected evaluated, got ${JSON.stringify(result)}`);
  return result.results;
}

describe("the client's cases (Preflight ruling 14)", () => {
  it("test_maps_pass_and_fail_with_misses: sends the signal and every rule by id, maps a pass and a failure's record misses", async () => {
    const rules = [ottlRule(0), ottlRule(1, { condition: `severity_text == "${fakeOttlEvaluatorMarker("fail")}"` })];

    const results = evaluated(await client.evaluate(evaluation(rules)));

    const [sent] = sentBodies();
    expect(sent?.signal).toBe("logs");
    expect((sent?.rules as Array<{ id: string }>).map((rule) => rule.id)).toEqual([ruleId(0), ruleId(1)]);
    expect(results[0]).toEqual(passedResult(ruleId(0)));
    expect(results[1]).toMatchObject({ id: ruleId(1), passed: false, error: null });
    expect(results[1]?.detail).toEqual({
      kind: "record_mismatch",
      context: "log",
      totalCount: 1,
      matchedCount: 0,
      missCount: 1,
      misses: [{ index: 0, reason: "condition evaluated to false", snippet: "{}" }],
    });
  });

  it("test_per_rule_error_from_evaluator: a rule's own error fails it, with the evaluator's words and no detail", async () => {
    const results = evaluated(
      await client.evaluate(evaluation([ottlRule(0, { condition: `attributes["${fakeOttlEvaluatorMarker("invalid")}"` })])),
    );

    expect(results[0]).toMatchObject({ passed: false, detail: null });
    expect(results[0]?.error).toMatch(/^OTTL syntax error: /);
  });

  it("test_local_prechecks_do_not_reach_the_service (moved to Go, check_test.go): every rule is sent as it is, and only the one the evaluator refuses fails", async () => {
    const rules = [
      textRule(0, "contains_regex", `(${fakeOttlEvaluatorMarker("invalid")}`),
      // A count rule without its count is the evaluator's rule error to give, not a refused request.
      ottlRule(1, { quantifier: "count" }),
      textRule(2, "contains_text", "hello"),
    ];

    const results = evaluated(await client.evaluate(evaluation(rules)));

    expect((sentBodies()[0]?.rules as unknown[]).length).toBe(3);
    expect(results[0]?.error).toMatch(/^Invalid regex: /);
    expect(results[1]?.id).toBe(ruleId(1));
    expect(results[2]).toEqual(passedResult(ruleId(2)));
  });

  it("test_unreachable_service_fails_sent_rules_only: nothing listening is unavailable for the whole request (the run ends Error, decision 3)", async () => {
    const unreachable = createOttlEvaluatorClient({ url: await closedUrl(), secret: "s".repeat(32) });

    expect(await unreachable.evaluate(evaluation([ottlRule(0), textRule(1, "contains_text", "x")]))).toEqual({
      kind: "unavailable",
      reason: "connection_refused",
    });
  });

  it("test_non_200_surfaces_detail: a 500 is unavailable with its status and code, logged without the evaluator's words", async () => {
    const log = recordingLog();
    const logged = createOttlEvaluatorClient({ url: fake.url, secret: fake.secret, log });
    fake.nextFault("error_500");

    expect(await logged.evaluate(evaluation([ottlRule(0)]))).toEqual({
      kind: "unavailable",
      reason: "server_error",
      status: 500,
      code: "internal_error",
    });
    expect(log.lines).toEqual([
      { details: { operation: "evaluate", reason: "server_error", status: 500, code: "internal_error" }, message: expect.any(String) },
    ]);
    expect(JSON.stringify(log.lines)).not.toContain("couldn't answer");
  });

  it("test_empty_payload_synthesizes_empty_document: no output is sent as null, never a document the client makes up", async () => {
    const results = evaluated(
      await client.evaluate(evaluation([ottlRule(0, { context: "datapoint", quantifier: "none" })], { signal: "metrics", output: null })),
    );

    expect(sentBodies()[0]?.output).toBeNull();
    expect(results).toHaveLength(1);
  });

  it("test_count_spec_is_forwarded: the count goes as it is", async () => {
    await client.evaluate(evaluation([ottlRule(0, { quantifier: "count", count: { operator: "between", value: 2, value2: 9 } })]));

    expect((sentBodies()[0]?.rules as Array<{ ottl: unknown }>)[0]?.ottl).toEqual({
      context: "log",
      quantifier: "count",
      condition: 'body == "hello"',
      count: { operator: "between", value: 2, value2: 9 },
    });
  });

  it("test_vacuous_zero_record_pass_gets_advisory: the evaluator's advisory passes through; the rule still passed, with no error", async () => {
    const advisory = "No log records in the output: all holds only because there was nothing to check.";
    const rules = [ottlRule(0), ottlRule(1, { quantifier: "none" }), ottlRule(2, { quantifier: "count", count: { operator: "eq", value: 0 } })];
    const { doFetch } = answering(() =>
      json({
        ottlVersion: "v0.162.0",
        results: [
          { ...passedResult(ruleId(0)), advisory },
          { ...passedResult(ruleId(1)), advisory: advisory.replace("all", "none") },
          passedResult(ruleId(2)),
        ],
      }),
    );

    const results = evaluated(await handMade(doFetch).evaluate(evaluation(rules)));

    expect(results.map((result) => [result.passed, result.error, result.advisory])).toEqual([
      [true, null, advisory],
      [true, null, advisory.replace("all", "none")],
      [true, null, null],
    ]);
  });

  it("test_invalid_base_url_never_raises: a URL fetch can't use is unavailable at every call, never a throw", async () => {
    const broken = createOttlEvaluatorClient({ url: "http://host:notaport", secret: "s".repeat(32) });

    expect(await broken.evaluate(evaluation([ottlRule(0)]))).toEqual({ kind: "unavailable", reason: "network" });
    expect(await broken.validate({ signal: "logs", rule: { kind: "contains_text", target: "output", pattern: "x" } })).toEqual({
      kind: "unavailable",
      reason: "network",
    });
    expect(await broken.health()).toEqual({ kind: "down", reason: "network" });
  });

  it("test_non_object_json_response_is_unavailable: a 200 that isn't the answer's object is malformed_reply, logged", async () => {
    const log = recordingLog();
    const { doFetch } = answering(() => json([{ id: ruleId(0), passed: true }]));

    expect(await handMade(doFetch, log).evaluate(evaluation([ottlRule(0)]))).toEqual({
      kind: "unavailable",
      reason: "malformed_reply",
      status: 200,
    });
    expect(log.lines).toEqual([{ details: { operation: "evaluate", reason: "malformed_reply", status: 200 }, message: expect.any(String) }]);
  });

  it("test_single_escaped_regex_fails_precheck_locally (moved to Go, check_test.go): the condition goes byte for byte, its escapes as written", async () => {
    const single = 'not IsMatch(body, "\\b[0-9]{4}\\b")';
    const double = 'not IsMatch(body, "\\\\b[0-9]{4}\\\\b")';

    await client.evaluate(evaluation([ottlRule(0, { condition: single }), ottlRule(1, { condition: double })]));

    const sent = sentBodies()[0]?.rules as Array<{ ottl: { condition: string } }>;
    expect(sent.map((rule) => rule.ottl.condition)).toEqual([single, double]);
  });

  it("test_count_field_type_mismatches_fail_locally: a request the contract wouldn't take is never sent: invalid_request, logged", async () => {
    const counts: unknown[] = [
      { operator: "eq", value: "2" },
      { operator: "eq", value: 2.5 },
      { operator: "eq", value: true },
      { operator: 5, value: 2 },
      { operator: "between", value: 1, value2: "9" },
      { operator: "eq", value: -1 },
      { operator: "eq", value: 2_147_483_648 },
    ];
    for (const count of counts) {
      const log = recordingLog();
      const { seen, doFetch } = answering(() => json({}));
      const result = await handMade(doFetch, log).evaluate(evaluation([ottlRule(0, { quantifier: "count", count })]));
      expect(result).toEqual({ kind: "unavailable", reason: "invalid_request" });
      expect(seen).toEqual([]);
      expect(log.lines).toEqual([{ details: { operation: "evaluate", reason: "invalid_request" }, message: expect.any(String) }]);
    }
  });

  it("test_distinct_rule_forwarded_and_mapped: the expression, condition and count go as they are; the distinct failure maps", async () => {
    const rule = ottlRule(0, {
      quantifier: "distinct",
      expression: `Concat([attributes["k8s.pod.name"], "${fakeOttlEvaluatorMarker("fail")}"], "")`,
      condition: 'severity_text == "ERROR"',
      count: { operator: "lte", value: 10 },
    });

    const results = evaluated(await client.evaluate(evaluation([rule])));

    const sent = (sentBodies()[0]?.rules as Array<{ ottl: Record<string, unknown> }>)[0]?.ottl;
    expect(sent).toEqual(rule.ottl);
    expect(results[0]).toMatchObject({ passed: false, error: null });
    expect(results[0]?.detail).toEqual({
      kind: "distinct_mismatch",
      totalCount: 1,
      matchedCount: 1,
      distinctCount: 1,
      samples: ["fake-ottl-evaluator"],
    });
  });

  it("test_distinct_condition_is_optional: no condition, or an empty one, is left out, never sent as \"\" (Ruling 33)", async () => {
    const distinct = { quantifier: "distinct", expression: 'attributes["route"]', count: { operator: "lte", value: 5 } };
    const absent = ottlRule(0, distinct);
    delete (absent.ottl as Record<string, unknown>).condition;

    await client.evaluate(evaluation([absent, ottlRule(1, { ...distinct, condition: "" })]));

    const sent = sentBodies()[0]?.rules as Array<{ ottl: Record<string, unknown> }>;
    for (const rule of sent) {
      expect(rule.ottl).not.toHaveProperty("condition");
      expect(rule.ottl).toEqual({ context: "log", ...distinct });
    }
  });

  it("test_distinct_prechecks_fail_locally (moved to Go, check_test.go): the evaluator's words for each rule pass through, by id", async () => {
    const words = [
      "A distinct rule needs an expression.",
      "A count or distinct rule needs a count.",
      "Only a distinct rule has an expression.",
      "The expression has a single-escaped regex sequence.",
    ];
    const rules = [
      ottlRule(0, { quantifier: "distinct", count: { operator: "lte", value: 5 } }),
      ottlRule(1, { quantifier: "distinct", expression: 'attributes["r"]' }),
      ottlRule(2, { expression: 'attributes["r"]' }),
      ottlRule(3, { quantifier: "distinct", expression: 'Concat([attributes["r"], "\\d"], "|")', count: { operator: "lte", value: 5 } }),
    ];
    const { seen, doFetch } = answering(() =>
      json({
        ottlVersion: "v0.162.0",
        results: rules.map((rule, index) => ({ id: rule.id, passed: false, error: words[index], advisory: null, detail: null })),
      }),
    );

    const results = evaluated(await handMade(doFetch).evaluate(evaluation(rules)));

    expect(seen).toHaveLength(1);
    expect(results.map((result) => result.error)).toEqual(words);
  });

  it("test_build_ottl_payload_unwraps_records (the unwrap moved to Go, output_test.go): the output's bytes go as they are, with truncated and without bytesOnDisk", async () => {
    const records = Buffer.from(JSON.stringify({ records: [{ resourceLogs: [{ scopeLogs: [] }] }, { resourceLogs: [] }] }));
    const testerOutput = { base64: records, bytesOnDisk: records.byteLength, truncated: true };

    await client.evaluate(evaluation([ottlRule(0)], { output: testerOutput }));

    expect(sentBodies()[0]?.output).toEqual({
      base64: { sizeBytes: records.byteLength, sha256: createHash("sha256").update(records).digest("hex") },
      truncated: true,
    });
  });

  it("test_merge_evaluated_preserves_order: results are matched by id and returned in the request's order", async () => {
    const rules = [ottlRule(0), textRule(1, "contains_text", "needle"), ottlRule(2, { quantifier: "any" }), textRule(3, "not_contains_text", "other")];
    const { doFetch } = answering(() =>
      json({
        ottlVersion: "v0.162.0",
        results: [
          { ...passedResult(ruleId(3)), passed: false },
          passedResult(ruleId(1)),
          passedResult(ruleId(2)),
          { ...passedResult(ruleId(0)), passed: false },
        ],
      }),
    );

    const results = evaluated(await handMade(doFetch).evaluate(evaluation(rules)));

    expect(results.map((result) => result.id)).toEqual(rules.map((rule) => rule.id));
    expect(results.map((result) => result.passed)).toEqual([false, true, true, false]);
  });
});

describe("evaluate", () => {
  it("sends the contract's request: JSON, the secret as a Bearer token, no redirect followed", async () => {
    const { seen, doFetch } = answering(() => json({ ottlVersion: "v0.162.0", results: [passedResult(ruleId(0))] }));

    await handMade(doFetch).evaluate(evaluation([ottlRule(0)]));

    expect(seen[0]?.url).toBe("http://evaluator.invalid/ottl/v1/evaluate");
    expect(seen[0]?.init).toMatchObject({
      method: "POST",
      headers: { authorization: `Bearer ${"s".repeat(32)}`, "content-type": "application/json" },
      redirect: "manual",
    });
  });

  it("keeps the fake's contract with every kind, target and quantifier, and each result fits the contracts' ValidationRuleResultSchema", async () => {
    const rules = [
      textRule(0, "contains_text", "a b", "stderr"),
      textRule(1, "not_contains_text", fakeOttlEvaluatorMarker("fail")),
      textRule(2, "contains_regex", `x|${fakeOttlEvaluatorMarker("fail")}`, "stderr"),
      textRule(3, "not_contains_regex", "\\d{3}"),
      ottlRule(4, { context: "resource", quantifier: "any" }),
      ottlRule(5, { condition: `body == "${fakeOttlEvaluatorMarker("error")}"` }),
      ottlRule(6, { quantifier: "count", count: { operator: "gte", value: 1 } }),
    ];

    const results = evaluated(await client.evaluate(evaluation(rules, { log: "line one\nline two\n" })));

    expect(results.map((result) => result.passed)).toEqual([true, false, false, true, true, false, true]);
    expect(results[1]?.detail?.kind).toBe("unexpected_match");
    expect(results[2]?.detail).toEqual({ kind: "no_match", source: "stderr", searchedCharacters: 18 });
    expect(results[5]?.error).toMatch(/^Not checked: /);
    for (const result of results) expect(ValidationRuleResultSchema.safeParse(result).success).toBe(true);
  });

  it("passes the truncated output's advisory through for output rules", async () => {
    const results = evaluated(
      await client.evaluate(
        evaluation([textRule(0, "contains_text", "x"), textRule(1, "contains_text", "x", "stderr")], {
          output: { base64: OUTPUT, truncated: true },
        }),
      ),
    );

    expect(results.map((result) => result.advisory)).toEqual(["Only the first 10 MiB of the output was checked (R-006).", null]);
  });

  it("an answer for other rules than those asked is no answer: a missing, an extra or a repeated id is malformed_reply", async () => {
    for (const fault of ["missing_result", "extra_result", "duplicate_result"] as const) {
      fake.nextFault(fault);
      expect(await client.evaluate(evaluation([ottlRule(0), ottlRule(1)]))).toEqual({
        kind: "unavailable",
        reason: "malformed_reply",
        status: 200,
      });
    }
  });

  it("a result that breaks the file's prose (an error on a pass, a pass with a detail) is malformed_reply", async () => {
    const detail = { kind: "no_match", source: "output", searchedCharacters: 1 };
    for (const result of [
      { ...passedResult(ruleId(0)), error: "x" },
      { ...passedResult(ruleId(0)), detail },
      { ...passedResult(ruleId(0)), passed: false, error: "x", detail },
      { ...passedResult(ruleId(0)), passed: "false" },
    ]) {
      const { doFetch } = answering(() => json({ ottlVersion: "v0.162.0", results: [result] }));
      expect(await handMade(doFetch).evaluate(evaluation([ottlRule(0)]))).toEqual({
        kind: "unavailable",
        reason: "malformed_reply",
        status: 200,
      });
    }
  });

  it("a reply the file refuses (its own malformed_reply fault) is malformed_reply, and the fake records it", async () => {
    fake.nextFault("malformed_reply");
    expect(await client.evaluate(evaluation([ottlRule(0)]))).toMatchObject({ kind: "unavailable", reason: "malformed_reply" });
    expect(fake.takeViolations()).toEqual([expect.stringContaining("evaluate reply 200 body")]);
  });

  it("a field it doesn't know yet is dropped, not refused: the platform may be older than the evaluator", async () => {
    const { doFetch } = answering(() =>
      json({ ottlVersion: "v0.162.0", elapsedMs: 3, results: [{ ...passedResult(ruleId(0)), durationMs: 1 }] }),
    );
    const results = evaluated(await handMade(doFetch).evaluate(evaluation([ottlRule(0)])));
    expect(results).toEqual([passedResult(ruleId(0))]);
  });

  it("busy (503 evaluator_busy) is its own answer, not logged, so the dispatcher may try once more (Preflight ruling 11)", async () => {
    const log = recordingLog();
    const logged = createOttlEvaluatorClient({ url: fake.url, secret: fake.secret, log });
    fake.nextFault("evaluator_busy");
    expect(await logged.evaluate(evaluation([ottlRule(0)]))).toEqual({ kind: "busy" });
    // A rule holding the marker asks for the same.
    expect(await logged.evaluate(evaluation([ottlRule(0, { condition: `body == "${fakeOttlEvaluatorMarker("busy")}"` })]))).toEqual({
      kind: "busy",
    });
    expect(log.lines).toEqual([]);
    // A 503 without that code is the evaluator failing, not busy.
    const { doFetch } = answering(() => json({ error: { code: "internal_error", message: "x" } }, 503));
    expect(await handMade(doFetch).evaluate(evaluation([ottlRule(0)]))).toEqual({
      kind: "unavailable",
      reason: "server_error",
      status: 503,
      code: "internal_error",
    });
  });

  it("each other status is its reason: 400 invalid_request, 413 payload_too_large, a wrong secret unauthorized, a redirect unexpected_status", async () => {
    fake.nextFault("invalid_request");
    expect(await client.evaluate(evaluation([ottlRule(0)]))).toEqual({
      kind: "unavailable",
      reason: "invalid_request",
      status: 400,
      code: "invalid_request",
    });
    fake.nextFault("payload_too_large");
    expect(await client.evaluate(evaluation([ottlRule(0)]))).toEqual({
      kind: "unavailable",
      reason: "payload_too_large",
      status: 413,
      code: "payload_too_large",
    });
    const wrong = createOttlEvaluatorClient({ url: fake.url, secret: "not-the-fake-secret-not-the-fake-secret" });
    expect(await wrong.evaluate(evaluation([ottlRule(0)]))).toEqual({
      kind: "unavailable",
      reason: "unauthorized",
      status: 401,
      code: "unauthorized",
    });
    const { doFetch } = answering(() => new Response(null, { status: 307, headers: { location: "http://elsewhere.invalid/" } }));
    expect(await handMade(doFetch).evaluate(evaluation([ottlRule(0)]))).toEqual({ kind: "unavailable", reason: "unexpected_status", status: 307 });
  });

  it("a connection reset before an answer: network", async () => {
    fake.nextFault("reset");
    expect(await client.evaluate(evaluation([ottlRule(0)]))).toEqual({ kind: "unavailable", reason: "network" });
  });

  it("one timer of 40 s over the request and its reply: timeout (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { doFetch, calls } = neverAnswering();
    let settled: EvaluateRulesResult | undefined;
    const pending = handMade(doFetch)
      .evaluate(evaluation([ottlRule(0)]))
      .then((result) => {
        settled = result;
      });

    expect(OTTL_EVALUATOR_EVALUATE_TIMEOUT_MS).toBe(40_000);
    await vi.advanceTimersByTimeAsync(40_000 - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toEqual({ kind: "unavailable", reason: "timeout" });
    expect(calls()).toBe(1);
  });

  it("a caller may shorten the timer (the lease left), never lengthen it (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (const [asked, fires] of [
      [10_000, 10_000],
      [60_000, 40_000],
    ] as const) {
      const { doFetch } = neverAnswering();
      let settled: EvaluateRulesResult | undefined;
      const pending = handMade(doFetch)
        .evaluate(evaluation([ottlRule(0)]), { timeoutMs: asked })
        .then((result) => {
          settled = result;
        });
      await vi.advanceTimersByTimeAsync(fires - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toEqual({ kind: "unavailable", reason: "timeout" });
    }
  });

  it("a reply whose body stops arriving: the one timer covers it too (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const doFetch = ((_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          init.signal!.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
    let settled: EvaluateRulesResult | undefined;
    const pending = handMade(doFetch)
      .evaluate(evaluation([ottlRule(0)]))
      .then((result) => {
        settled = result;
      });

    await vi.advanceTimersByTimeAsync(OTTL_EVALUATOR_EVALUATE_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toEqual({ kind: "unavailable", reason: "timeout" });
  });

  it("honours the caller's signal: ended before the call, nothing is sent (not_sent); during it, aborted", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const { seen, doFetch } = answering(() => json({}));
    expect(await handMade(doFetch).evaluate(evaluation([ottlRule(0)]), { signal: stopped.signal })).toEqual({
      kind: "unavailable",
      reason: "not_sent",
    });
    expect(seen).toEqual([]);

    const controller = new AbortController();
    const pending = handMade(neverAnswering().doFetch).evaluate(evaluation([ottlRule(0)]), { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ kind: "unavailable", reason: "aborted" });
  });

  describe("an answer is read up to 6 MiB (Ruling 33's note)", () => {
    const body = JSON.stringify({ ottlVersion: "v0.162.0", results: [passedResult(ruleId(0))] });

    it("is 6 MiB by default", () => {
      expect(MAX_OTTL_EVALUATOR_REPLY_BYTES).toBe(6 * 1024 * 1024);
    });

    it("reads an answer at the cap", async () => {
      const padded = body.padEnd(1024, " ");
      const { doFetch } = answering(() => new Response(padded, { status: 200 }));
      expect((await handMade(doFetch, undefined, 1024).evaluate(evaluation([ottlRule(0)]))).kind).toBe("evaluated");
    });

    it("a streamed answer one byte over: oversized_reply, logged, and the rest never read", async () => {
      const log = recordingLog();
      const encoded = new TextEncoder().encode(body.padEnd(1025, " "));
      let pulls = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(pulls === 1 ? encoded : new Uint8Array(1024));
          if (pulls === 100) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      const { doFetch } = answering(() => new Response(stream, { status: 200 }));

      expect(await handMade(doFetch, log, 1024).evaluate(evaluation([ottlRule(0)]))).toEqual({
        kind: "unavailable",
        reason: "oversized_reply",
        status: 200,
      });
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThan(100);
      expect(log.lines).toEqual([{ details: { operation: "evaluate", reason: "oversized_reply", status: 200 }, message: expect.any(String) }]);
    });

    it("a declared Content-Length over the cap: oversized_reply, nothing read", async () => {
      const { doFetch } = answering(() => new Response(body, { status: 200, headers: { "content-length": "1025" } }));
      expect(await handMade(doFetch, undefined, 1024).evaluate(evaluation([ottlRule(0)]))).toEqual({
        kind: "unavailable",
        reason: "oversized_reply",
        status: 200,
      });
    });
  });

  it("refuses to send what the contract wouldn't take: no rules, 201, a repeated id, a kind and its fields mixed up, an output over 10 MiB", async () => {
    const rules200 = Array.from({ length: 201 }, (_, index) => ({ ...textRule(0, "contains_text", "x"), id: `rule-${index}` }));
    for (const request of [
      evaluation([]),
      evaluation(rules200),
      evaluation([ottlRule(0), ottlRule(0)]),
      evaluation([{ ...textRule(0, "contains_text", "x"), ottl: { context: "log", quantifier: "all", condition: "true" } }]),
      evaluation([{ ...ottlRule(0), target: "stderr" }]),
      evaluation([{ ...ottlRule(0), pattern: "x" }]),
      evaluation([textRule(0, "contains_text", "")]),
      evaluation([ottlRule(0)], { output: { base64: new Uint8Array(10_485_761), truncated: false } }),
      evaluation([ottlRule(0)], { log: "x".repeat(262_145) }),
    ]) {
      const { seen, doFetch } = answering(() => json({}));
      expect(await handMade(doFetch).evaluate(request)).toEqual({ kind: "unavailable", reason: "invalid_request" });
      expect(seen).toEqual([]);
    }
    // 200 rules and a log of 262,144 characters (emoji, two UTF-16 units each) are within it.
    const atMost = Array.from({ length: 200 }, (_, index) => ({ ...textRule(0, "contains_text", "x"), id: `rule-${index}` }));
    expect(evaluated(await client.evaluate(evaluation(atMost, { log: "\u{1F600}".repeat(262_144) })))).toHaveLength(200);
  });

  it("never puts the secret, a rule's text, the output or the log in a result or a log line", async () => {
    const secret = "secret-that-must-never-appear-0123456789";
    const log = recordingLog();
    const request = evaluation([textRule(0, "contains_text", "pattern-marker")], {
      output: { base64: Buffer.from("output-marker"), truncated: false },
      log: "log-marker",
    });
    const results: unknown[] = [
      await createOttlEvaluatorClient({ url: fake.url, secret, log }).evaluate(request),
      await createOttlEvaluatorClient({ url: await closedUrl(), secret, log }).evaluate(request),
    ];
    fake.nextFault("malformed_reply");
    results.push(await createOttlEvaluatorClient({ url: fake.url, secret: fake.secret, log }).evaluate(request));
    fake.takeViolations();
    fake.nextFault("error_500");
    results.push(await createOttlEvaluatorClient({ url: fake.url, secret: fake.secret, log }).evaluate(request));
    expect(log.lines.length).toBeGreaterThanOrEqual(3);
    for (const shown of [JSON.stringify(results), JSON.stringify(log.lines)]) {
      for (const hidden of [secret, "pattern-marker", "output-marker", Buffer.from("output-marker").toString("base64"), "log-marker"]) {
        expect(shown).not.toContain(hidden);
      }
    }
  });

  it("refuses a URL carrying a user name or password when it is built, without quoting it", () => {
    for (const url of ["http://user:url-password@evaluator:8003", "http://url-user@evaluator:8003"]) {
      expect(() => createOttlEvaluatorClient({ url, secret: "s".repeat(32) })).toThrow(
        "The OTTL evaluator's URL must not carry a user name or password.",
      );
    }
  });
});

describe("validate (decision 6; Ruling 33)", () => {
  const valid = (result: ValidateRuleResult) => result;

  it("a rule the evaluator takes is valid; the request is the contract's, with no id", async () => {
    expect(valid(await client.validate({ signal: "logs", rule: { kind: "ottl", target: "output", ottl: ottlRule(0).ottl } }))).toEqual({
      kind: "valid",
    });
    const [request] = fake.takeRequests();
    expect(request?.operation).toBe("validate");
    expect(request?.body).toEqual({ signal: "logs", rule: { kind: "ottl", target: "output", ottl: ottlRule(0).ottl } });
  });

  it("the evaluator's problems pass through as it words them: the API shows them as they are", async () => {
    const result = await client.validate({
      signal: "traces",
      rule: { kind: "ottl", target: "output", ottl: { context: "log", quantifier: "all", condition: `body == "${fakeOttlEvaluatorMarker("invalid")}"` } },
    });

    expect(result).toEqual({
      kind: "invalid",
      problems: [
        { field: "ottl.context", message: 'A traces rule can\'t use the "log" context: use span, spanevent, resource or scope.' },
        { field: "ottl.condition", message: expect.stringMatching(/^OTTL syntax error: /) },
      ],
    });
    expect(
      await client.validate({ signal: "logs", rule: { kind: "contains_regex", target: "stderr", pattern: `(${fakeOttlEvaluatorMarker("invalid")}` } }),
    ).toEqual({ kind: "invalid", problems: [{ field: "pattern", message: expect.stringMatching(/^Invalid regex: /) }] });
  });

  it("an empty condition is left out, never sent as \"\"", async () => {
    await client.validate({
      signal: "logs",
      rule: { kind: "ottl", target: "output", ottl: { context: "log", quantifier: "distinct", condition: "", expression: "body", count: { operator: "eq", value: 1 } } },
    });
    const [request] = fake.takeRequests();
    expect((request?.body as { rule: { ottl: Record<string, unknown> } }).rule.ottl).not.toHaveProperty("condition");
  });

  it("busy is its own answer; every other failure unavailable; a rule the contract wouldn't take is never sent", async () => {
    fake.nextFault("evaluator_busy");
    expect(await client.validate({ signal: "logs", rule: { kind: "contains_text", target: "output", pattern: "x" } })).toEqual({ kind: "busy" });
    expect(
      await client.validate({ signal: "logs", rule: { kind: "contains_text", target: "output", pattern: fakeOttlEvaluatorMarker("unavailable") } }),
    ).toEqual({ kind: "unavailable", reason: "server_error", status: 500, code: "internal_error" });
    fake.nextFault("malformed_reply");
    expect(await client.validate({ signal: "logs", rule: { kind: "contains_text", target: "output", pattern: "x" } })).toEqual({
      kind: "unavailable",
      reason: "malformed_reply",
      status: 200,
    });
    expect(fake.takeViolations()).toEqual([expect.stringContaining("validate reply 200 body")]);

    const { seen, doFetch } = answering(() => json({}));
    expect(await handMade(doFetch).validate({ signal: "logs", rule: { kind: "ottl", target: "stderr", ottl: ottlRule(0).ottl } })).toEqual({
      kind: "unavailable",
      reason: "invalid_request",
    });
    expect(seen).toEqual([]);
  });

  it("an answer whose problems don't agree with valid is malformed_reply", async () => {
    for (const answer of [
      { valid: false, ottlVersion: "v0.162.0" },
      { valid: true, problems: [{ field: "pattern", message: "x" }], ottlVersion: "v0.162.0" },
      { valid: false, problems: [], ottlVersion: "v0.162.0" },
    ]) {
      const { doFetch } = answering(() => json(answer));
      expect(await handMade(doFetch).validate({ signal: "logs", rule: { kind: "contains_text", target: "output", pattern: "x" } })).toEqual({
        kind: "unavailable",
        reason: "malformed_reply",
        status: 200,
      });
    }
  });

  it("one timer of 5 s (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(OTTL_EVALUATOR_VALIDATE_TIMEOUT_MS).toBe(5_000);
    let settled: ValidateRuleResult | undefined;
    const pending = handMade(neverAnswering().doFetch)
      .validate({ signal: "logs", rule: { kind: "contains_text", target: "output", pattern: "x" } })
      .then((result) => {
        settled = result;
      });
    await vi.advanceTimersByTimeAsync(5_000 - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toEqual({ kind: "unavailable", reason: "timeout" });
  });
});

describe("lint (D25 Task 3)", () => {
  it("sends the contract's request, an empty list left out, and answers each text's verdict in order, by kind and index", async () => {
    const result = await client.lint({
      context: "datapoint",
      conditions: ["true", `name == "${fakeOttlEvaluatorMarker("invalid")}"`],
      statements: [],
      valueExpressions: ["attributes[\"route\"]"],
    });
    expect(result).toEqual({
      kind: "linted",
      ottlVersion: "v0.162.0",
      items: [
        { kind: "condition", index: 0, valid: true, error: null },
        { kind: "condition", index: 1, valid: false, error: expect.stringMatching(/^OTTL syntax error: /) },
        { kind: "valueExpression", index: 0, valid: true, error: null },
      ],
    });
    expect(fake.takeRequests()).toEqual([
      {
        operation: "lint",
        body: { context: "datapoint", conditions: ["true", `name == "${fakeOttlEvaluatorMarker("invalid")}"`], valueExpressions: ["attributes[\"route\"]"] },
      },
    ]);
  });

  it("busy is its own answer; every other failure unavailable; an answer for other texts is malformed_reply", async () => {
    const one = { context: "log" as const, conditions: ["true", "false"] };
    fake.nextFault("evaluator_busy");
    expect(await client.lint(one)).toEqual({ kind: "busy" });
    expect(await client.lint({ context: "log", conditions: [fakeOttlEvaluatorMarker("unavailable")] })).toEqual({
      kind: "unavailable",
      reason: "server_error",
      status: 500,
      code: "internal_error",
    });
    for (const fault of ["missing_result", "extra_result", "duplicate_result"] as const) {
      fake.nextFault(fault);
      expect(await client.lint(one)).toEqual({ kind: "unavailable", reason: "malformed_reply", status: 200 });
    }
    fake.nextFault("malformed_reply");
    expect(await client.lint(one)).toEqual({ kind: "unavailable", reason: "malformed_reply", status: 200 });
    expect(fake.takeViolations()).toEqual([expect.stringContaining("lint reply 200 body")]);
    // An error on a valid item, or none on an invalid one, breaks the file's prose.
    for (const items of [
      [{ kind: "condition", index: 0, valid: true, error: "x" }],
      [{ kind: "condition", index: 0, valid: false }],
    ]) {
      const { doFetch } = answering(() => json({ ottlVersion: "v0.162.0", items }));
      expect(await handMade(doFetch).lint({ context: "log", conditions: ["true"] })).toEqual({ kind: "unavailable", reason: "malformed_reply", status: 200 });
    }
  });

  it("refuses to send what the contract wouldn't take: no text, 201, a text over 8,192 characters, an unknown context", async () => {
    const { seen, doFetch } = answering(() => json({}));
    const log = recordingLog();
    const handMadeClient = handMade(doFetch, log);
    for (const request of [
      { context: "log", conditions: [] },
      { context: "log", conditions: Array.from({ length: 150 }, () => "true"), statements: Array.from({ length: 51 }, () => "set(body, 1)") },
      { context: "log", valueExpressions: ["x".repeat(8193)] },
      { context: "trace", conditions: ["true"] },
    ]) {
      expect(await handMadeClient.lint(request as Parameters<OttlEvaluatorClient["lint"]>[0])).toEqual({ kind: "unavailable", reason: "invalid_request" });
    }
    expect(seen).toEqual([]);
    expect(log.lines.every((line) => line.details.operation === "lint" && line.details.reason === "invalid_request")).toBe(true);
    // 200 in all is sent.
    const two = await client.lint({ context: "log", conditions: Array.from({ length: 199 }, () => "true"), statements: ["set(body, 1)"] });
    expect(two.kind === "linted" && two.items.length === 200 && two.items[199]!.kind === "statement").toBe(true);
    fake.takeRequests();
  });

  it("never logs a text: a failure's line holds the operation, reason, status and code only", async () => {
    const marker = "MARKER-lint-4d2";
    const log = recordingLog();
    const { doFetch } = answering(() => json({ error: { code: "internal_error", message: marker } }, 500));
    await handMade(doFetch, log).lint({ context: "log", conditions: [`body == "${marker}"`] });
    expect(log.lines).toHaveLength(1);
    expect(JSON.stringify(log.lines).includes(marker)).toBe(false);
    expect(log.lines[0]!.details).toEqual({ operation: "lint", reason: "server_error", status: 500, code: "internal_error" });
  });

  it("reads an answer up to 6 MiB; one byte over is oversized_reply, logged (Ruling 168)", async () => {
    expect(MAX_OTTL_EVALUATOR_LINT_REPLY_BYTES).toBe(6 * 1024 * 1024);
    const answer = JSON.stringify({ ottlVersion: "v0.162.0", items: [{ kind: "condition", index: 0, valid: true }] });
    // JSON takes trailing whitespace: the same answer padded to the cap, then one byte past it.
    const padded = (size: number) => answer + " ".repeat(size - Buffer.byteLength(answer));
    const atCap = answering(() => new Response(padded(MAX_OTTL_EVALUATOR_LINT_REPLY_BYTES), { status: 200 }));
    expect((await handMade(atCap.doFetch).lint({ context: "log", conditions: ["true"] })).kind).toBe("linted");
    const log = recordingLog();
    const over = answering(() => new Response(padded(MAX_OTTL_EVALUATOR_LINT_REPLY_BYTES + 1), { status: 200 }));
    expect(await handMade(over.doFetch, log).lint({ context: "log", conditions: ["true"] })).toEqual({
      kind: "unavailable",
      reason: "oversized_reply",
      status: 200,
    });
    expect(log.lines.map((line) => line.details)).toEqual([{ operation: "lint", reason: "oversized_reply", status: 200 }]);
  });

  it("one timer of 15 s: the evaluator's 10 s kill, its 1 s wait, and the carrying (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(OTTL_EVALUATOR_LINT_TIMEOUT_MS).toBe(15_000);
    let settled: LintTextsResult | undefined;
    const pending = handMade(neverAnswering().doFetch)
      .lint({ context: "log", conditions: ["true"] })
      .then((result) => {
        settled = result;
      });
    await vi.advanceTimersByTimeAsync(15_000 - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toEqual({ kind: "unavailable", reason: "timeout" });
  });
});

describe("health", () => {
  it("200: up, with the evaluator's OTTL version; asked without the secret, following no redirect", async () => {
    expect(await client.health()).toEqual({ kind: "up", ottlVersion: "v0.162.0" });
    const { seen, doFetch } = answering(() => json({ status: "ok", ottlVersion: "v0.162.0" }));
    await handMade(doFetch).health();
    expect(seen[0]?.url).toBe("http://evaluator.invalid/health");
    expect(seen[0]?.init.headers).not.toHaveProperty("authorization");
    expect(seen[0]?.init.redirect).toBe("manual");
  });

  it("down: nothing listening, the connection reset, another status, a body the file refuses", async () => {
    expect(await createOttlEvaluatorClient({ url: await closedUrl(), secret: "s".repeat(32) }).health()).toEqual({
      kind: "down",
      reason: "connection_refused",
    });
    fake.setHealth("down");
    try {
      expect(await client.health()).toEqual({ kind: "down", reason: "network" });
    } finally {
      fake.setHealth("up");
    }
    expect(await handMade(answering(() => json({ error: { code: "internal_error", message: "x" } }, 503)).doFetch).health()).toEqual({
      kind: "down",
      reason: "http_status",
      status: 503,
    });
    expect(await handMade(answering(() => json({ status: "ok" })).doFetch).health()).toEqual({
      kind: "down",
      reason: "malformed_reply",
      status: 200,
    });
  });

  it("no answer within 5 s: down, timeout (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(OTTL_EVALUATOR_HEALTH_TIMEOUT_MS).toBe(5_000);
    let settled: unknown;
    const pending = handMade(neverAnswering().doFetch)
      .health()
      .then((result) => {
        settled = result;
      });
    await vi.advanceTimersByTimeAsync(5_000 - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toEqual({ kind: "down", reason: "timeout" });
  });
});
