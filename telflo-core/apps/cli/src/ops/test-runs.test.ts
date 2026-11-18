import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_RUN_STATUSES as CONTRACT_STATUSES, type PublicTestRun } from "@telflo/contracts";
import { envelope, fakeFetch, routedFetch, type Answer, type FakeFetch } from "../../tests/fake-fetch.js";
import { ApiClient, ApiError } from "../api.js";
import { EXIT, setIo, type ExitError } from "../output.js";
import type { TestSpec } from "../test-spec-file.js";
import {
  assertTestTargetUsage,
  BACKOFF_AFTER_POLLS,
  buildTestRunBody,
  ENDED_TEST_RUN_STATUSES,
  getTestRunOutput,
  NEED_A_TARGET_MESSAGE,
  queueTestRun,
  resolveTestTarget,
  setTestRunClock,
  TEST_RUN_STATUSES,
  testRunClock,
  VERSION_NEEDS_CONFIG_MESSAGE,
  waitForTestRun,
} from "./test-runs.js";

/*
 * Test runs' data operations (D27 decision 27): the body, the target and its pin, the poll with
 * its backoff on a fake clock, a 429's Retry-After while polling, and the
 * create's and output's long timeout.
 */

const SERVER = "https://telflo.example";
const CONFIGURATION = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const RUN = "5e3b1c2d-4a5f-4b6c-8d7e-9f0a1b2c3d4e";

const SPEC: TestSpec = {
  signal: "logs",
  pipeline: "logs/in",
  duration: 3,
  sample: '{"resourceLogs":[]}',
  rules: [{ kind: "ottl", target: "output", ottl: { context: "log", quantifier: "count", condition: "true", count: { operator: "eq", value: 0 } } }],
};

let now: number;
let sleeps: number[];

beforeEach(() => {
  now = 1_000_000;
  sleeps = [];
  setTestRunClock({
    now: () => now,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    },
  });
  setIo({ stderr: () => undefined });
});

afterEach(() => {
  setTestRunClock();
  setIo();
});

function clientOf(fake: FakeFetch): ApiClient {
  return new ApiClient({ server: SERVER, token: `tf_${randomBytes(32).toString("base64url")}`, fetch: fake.fetch, sleep: (ms) => testRunClock().sleep(ms) });
}

function run(status: PublicTestRun["status"]): PublicTestRun {
  return {
    id: RUN,
    status,
    success: ENDED_TEST_RUN_STATUSES.has(status) ? status === "succeeded" : null,
    signal: "logs",
    pipeline: "logs/in",
    durationMs: null,
    collectorVersion: "0.147.0",
    distribution: "otelcol-contrib",
    validationResults: null,
    mutations: null,
    compatibility: null,
    errorMessage: null,
    createdAt: "2026-10-26T00:00:00.000Z",
  };
}

/** A fake answering the run's GETs with `statuses` in turn (the last repeated). */
function polling(statuses: Array<PublicTestRun["status"] | Answer>): FakeFetch {
  return fakeFetch((_call, index) => {
    const next = statuses[Math.min(index, statuses.length - 1)]!;
    return typeof next === "string" ? { json: run(next) } : next;
  });
}

describe("the statuses (drift)", () => {
  it("are the contracts', the last three ended", () => {
    expect([...TEST_RUN_STATUSES]).toEqual([...CONTRACT_STATUSES]);
    expect([...ENDED_TEST_RUN_STATUSES]).toEqual(["succeeded", "failed", "validation_failed"]);
  });
});

describe("buildTestRunBody", () => {
  it("a text's run with inline rules, in D25's field names", () => {
    expect(buildTestRunBody(SPEC, { yaml: "receivers: {}\n" })).toEqual({
      sample: SPEC.sample,
      signal: "logs",
      pipeline: "logs/in",
      durationSeconds: 3,
      rules: SPEC.rules,
      yaml: "receivers: {}\n",
    });
  });

  it("a version's run with useSavedRules sends no rules and no text", () => {
    const body = buildTestRunBody(SPEC, { configurationId: CONFIGURATION, versionNumber: 2 }, { useSavedRules: true });
    expect(body).toEqual({
      sample: SPEC.sample,
      signal: "logs",
      pipeline: "logs/in",
      durationSeconds: 3,
      useSavedRules: true,
      configurationId: CONFIGURATION,
      versionNumber: 2,
    });
  });

  it("the choice's collector beats the spec's, field by field; none sends none", () => {
    const spec = { ...SPEC, collectorVersion: "0.100.0", distribution: "otelcol-contrib" };
    expect(buildTestRunBody(spec, { yaml: "x" }, { pin: { collectorVersion: "0.147.0", distribution: "clickstack" } })).toMatchObject({
      collectorVersion: "0.147.0",
      distribution: "clickstack",
    });
    expect(buildTestRunBody(spec, { yaml: "x" }, { pin: { collectorVersion: undefined } })).toMatchObject({
      collectorVersion: "0.100.0",
      distribution: "otelcol-contrib",
    });
    const none = buildTestRunBody(SPEC, { yaml: "x" });
    expect("collectorVersion" in none || "distribution" in none).toBe(false);
  });
});

describe("assertTestTargetUsage", () => {
  const usage = (input: Parameters<typeof assertTestTargetUsage>[0]): string => {
    try {
      assertTestTargetUsage(input);
    } catch (error) {
      expect((error as ExitError).exitCode).toBe(EXIT.USAGE);
      return (error as ExitError).message;
    }
    return "";
  };

  it("needs a text or a configuration, and a version only with a configuration", () => {
    expect(usage({ hasYaml: false })).toBe(NEED_A_TARGET_MESSAGE);
    expect(usage({ hasYaml: false, version: 3 })).toBe(NEED_A_TARGET_MESSAGE);
    expect(usage({ hasYaml: true, version: 3 })).toBe(VERSION_NEEDS_CONFIG_MESSAGE);
    expect(usage({ hasYaml: true })).toBe("");
    expect(usage({ hasYaml: false, configurationId: CONFIGURATION })).toBe("");
    expect(usage({ hasYaml: true, configurationId: CONFIGURATION, version: 2 })).toBe("");
  });
});

describe("resolveTestTarget", () => {
  const configuration = { id: CONFIGURATION, versionNumber: 4, collectorVersion: "0.140.0", distribution: "clickstack" };
  const versions = {
    items: [
      { versionNumber: 4, collectorVersion: "0.140.0", distribution: "clickstack" },
      { versionNumber: 2, collectorVersion: "0.120.0", distribution: "clickstack" },
    ],
    nextCursor: null,
  };
  const configurations = () =>
    routedFetch({
      [`GET /configurations/${CONFIGURATION}`]: { json: configuration },
      [`GET /configurations/${CONFIGURATION}/versions`]: { json: versions },
    });

  it("a text alone: the flags' collector, no request", async () => {
    const fake = configurations();
    const target = await resolveTestTarget(clientOf(fake), { yaml: "r: {}\n", collectorVersion: "0.147.0" });
    expect(target).toEqual({ source: { yaml: "r: {}\n" }, pin: { collectorVersion: "0.147.0", distribution: undefined } });
    expect(fake.calls).toHaveLength(0);
  });

  it("a text with --config: the stored pin fills what the flags leave unset", async () => {
    const target = await resolveTestTarget(clientOf(configurations()), { yaml: "x", configurationId: CONFIGURATION, collectorVersion: "0.147.0" });
    expect(target.pin).toEqual({ collectorVersion: "0.147.0", distribution: "clickstack" });
    expect(target.storedPin).toEqual({ collectorVersion: "0.140.0", distribution: "clickstack", versionNumber: 4, configurationId: CONFIGURATION });
    const named = await resolveTestTarget(clientOf(configurations()), { yaml: "x", configurationId: CONFIGURATION, version: 2 });
    expect(named.pin).toEqual({ collectorVersion: "0.120.0", distribution: "clickstack" });
  });

  it("a version's run: the latest version (route 5), or the one named without a request; the id canonicalized", async () => {
    const fake = configurations();
    expect(await resolveTestTarget(clientOf(fake), { configurationId: CONFIGURATION.toUpperCase(), distribution: "clickstack" })).toEqual({
      source: { configurationId: CONFIGURATION, versionNumber: 4 },
      pin: { collectorVersion: undefined, distribution: "clickstack" },
    });
    expect(fake.calls.map((call) => call.url.pathname)).toEqual([`/api/public/v1/configurations/${CONFIGURATION}`]);
    const named = configurations();
    expect((await resolveTestTarget(clientOf(named), { configurationId: CONFIGURATION, version: 2 })).source).toEqual({
      configurationId: CONFIGURATION,
      versionNumber: 2,
    });
    expect(named.calls).toHaveLength(0);
  });

  it("refuses a malformed id before any request (exit 2)", async () => {
    const fake = configurations();
    await expect(resolveTestTarget(clientOf(fake), { configurationId: "acme" })).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("queueTestRun and getTestRunOutput", () => {
  it("POSTs the body with the long timeout and answers the id; reads the output's bytes", async () => {
    let signal: AbortSignal | undefined;
    const fake = routedFetch({
      "POST /test-runs": (call) => {
        signal = call.signal;
        return { status: 202, json: { id: RUN, status: "queued" } };
      },
      [`GET /test-runs/${RUN}/output`]: { text: "the output" },
    });
    const client = clientOf(fake);
    expect(await queueTestRun(client, buildTestRunBody(SPEC, { yaml: "x" }))).toBe(RUN);
    expect(JSON.parse(fake.calls[0]!.body!)).toMatchObject({ yaml: "x", signal: "logs" });
    expect(signal?.aborted).toBe(false);
    const output = await getTestRunOutput(client, RUN);
    expect(Buffer.isBuffer(output) && output.equals(Buffer.from("the output"))).toBe(true);
    expect(fake.calls[1]!.headers.get("accept")).toBe("text/plain, application/json");
  });
});

describe("waitForTestRun", () => {
  it("polls until an ended status, the first at once and then a second apart", async () => {
    const fake = polling(["queued", "running", "succeeded"]);
    const outcome = await waitForTestRun(clientOf(fake), RUN, { timeoutMs: 60_000 });
    expect(outcome).toEqual({ finished: true, run: run("succeeded") });
    expect(fake.calls.map((call) => call.url.pathname)).toEqual(Array(3).fill(`/api/public/v1/test-runs/${RUN}`));
    expect(sleeps).toEqual([1_000, 1_000]);
  });

  it.each(["failed", "validation_failed"] as const)("%s ends it too", async (status) => {
    expect(await waitForTestRun(clientOf(polling([status])), RUN, { timeoutMs: 60_000 })).toMatchObject({ finished: true, run: { status } });
  });

  it("backs off five times after the first ten polls (inside 60 a minute)", async () => {
    const fake = polling(["running"]);
    const outcome = await waitForTestRun(clientOf(fake), RUN, { timeoutMs: 40_000, pollIntervalMs: 1_000 });
    expect(outcome).toEqual({ finished: false, lastStatus: "running" });
    // Polls 1-11 a second apart, then every five seconds until the deadline.
    expect(sleeps.slice(0, BACKOFF_AFTER_POLLS)).toEqual(Array(BACKOFF_AFTER_POLLS).fill(1_000));
    expect(sleeps.slice(BACKOFF_AFTER_POLLS)).toEqual(Array(6).fill(5_000));
    expect(fake.calls).toHaveLength(16);
  });

  it("a deadline already past polls nothing", async () => {
    const fake = polling(["queued"]);
    expect(await waitForTestRun(clientOf(fake), RUN, { timeoutMs: 0 })).toEqual({ finished: false, lastStatus: null });
    expect(fake.calls).toHaveLength(0);
  });

  it("a 429 while polling waits its Retry-After (the client's), then keeps polling", async () => {
    const limited: Answer = { status: 429, json: envelope("rate_limited", "Too many requests."), headers: { "retry-after": "7" } };
    const fake = polling([limited, "succeeded"]);
    expect(await waitForTestRun(clientOf(fake), RUN, { timeoutMs: 60_000 })).toMatchObject({ finished: true });
    expect(sleeps).toEqual([7_000]);
  });

  it("another refusal ends the wait as an ApiError", async () => {
    const fake = polling([{ status: 404, json: envelope("test_run_not_found", "No such test run.") }]);
    const refused = waitForTestRun(clientOf(fake), RUN, { timeoutMs: 60_000 });
    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(refused).rejects.toMatchObject({ status: 404, code: "test_run_not_found" });
  });

  it("the real clock is back after setTestRunClock()", async () => {
    setTestRunClock();
    const clock = testRunClock();
    const before = Date.now();
    expect(Math.abs(clock.now() - before)).toBeLessThan(60_000);
    await clock.sleep(0);
  });
});
