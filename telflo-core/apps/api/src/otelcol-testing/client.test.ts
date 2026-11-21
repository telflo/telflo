import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fakeOtelcolTestingMarker,
  startFakeOtelcolTesting,
  type FakeOtelcolTesting,
  type FakeOtelcolTestingFault,
} from "../testing/fake-otelcol-testing.js";
import {
  createOtelcolTestingClient,
  isOtelcolTestingDuration,
  MAX_OTELCOL_TESTING_REPLY_BYTES,
  OTELCOL_TESTING_HEALTH_TIMEOUT_MS,
  otelcolTestingRunTimeoutMs,
  RELEASABLE_TESTER_REASONS,
  type OtelcolTestingClient,
  type OtelcolTestingClientLog,
  type TestRunRequest,
  type TestRunResult,
  type TesterUnavailableReason,
} from "./client.js";

// The platform's client for the collector tester, against the OpenAPI-checked
// fake, and against a hand-made fetch for what the fake can't be pushed to
// answer. Every failure is `unavailable`, never a throw, and says whether the
// run may go back to the queue: only when the tester refused it before
// starting anything, or the connection was refused before anything was sent.

let fake: FakeOtelcolTesting;
let client: OtelcolTestingClient;

beforeAll(async () => {
  fake = await startFakeOtelcolTesting();
  client = createOtelcolTestingClient({ url: `${fake.url}/`, secret: fake.secret });
});

afterEach(() => {
  vi.useRealTimers();
  expect(fake.takeViolations()).toEqual([]);
  fake.takeRequests();
});

afterAll(async () => {
  await fake.close();
});

const INPUT = new TextEncoder().encode('{"resourceLogs":[{"marker":"input-marker"}]}');

const RUN: TestRunRequest = {
  runId: "0190f5c2-7d1a-7c4e-8a3b-4f2e3d4c5b6a",
  yaml: "receivers:\n  otlp: {}\n",
  pipeline: "logs",
  signal: "logs",
  durationSeconds: 5,
  distribution: "otelcol-contrib",
  version: "0.162.0",
  input: INPUT,
};

const withMarker = (marker: Parameters<typeof fakeOtelcolTestingMarker>[0]): TestRunRequest => ({
  ...RUN,
  yaml: `${RUN.yaml}${fakeOtelcolTestingMarker(marker)}\n`,
});

/** An answer that keeps the contract, for hand-made replies. */
function answerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "succeeded",
    strategy: "otlp",
    kwokEnabled: false,
    collectorVersion: RUN.version,
    logs: "",
    mutatedYaml: "receivers: {}\n",
    mutations: [],
    compatibility: [],
    output: { base64: Buffer.from("out").toString("base64"), bytesOnDisk: 3, truncated: false },
    decodedInput: null,
    timings: { totalMs: 1, readyMs: null, informerMs: null, replayMs: null, holdMs: null, stopMs: null },
    ...overrides,
  };
}

/** A fetch that answers `response` and records what it was asked. */
function answering(response: (init: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return response(init);
  }) as unknown as typeof fetch;
  return { seen, doFetch };
}

function handMade(doFetch: typeof fetch, log?: OtelcolTestingClientLog, maxReplyBytes?: number): OtelcolTestingClient {
  return createOtelcolTestingClient({
    url: "http://tester.invalid",
    secret: "s".repeat(32),
    fetch: doFetch,
    ...(log === undefined ? {} : { log }),
    ...(maxReplyBytes === undefined ? {} : { maxReplyBytes }),
  });
}

type LogLine = { details: Record<string, unknown>; message: string };

/** A log that records what it is told: `lines` at error, `warnings` at warn. */
function recordingLog(): OtelcolTestingClientLog & { lines: LogLine[]; warnings: LogLine[] } {
  const lines: LogLine[] = [];
  const warnings: LogLine[] = [];
  return {
    lines,
    warnings,
    error: (details, message) => lines.push({ details, message }),
    warn: (details, message) => warnings.push({ details, message }),
  };
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

/** The port of a server that just closed: nothing listens there. */
async function closedUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/**
 * The reasons a run may be released for, written out here rather than read
 * from the client: the tester refused it before starting anything, or
 * nothing was sent: the connection was refused, or the tester's name didn't
 * resolve.
 */
const RELEASED: ReadonlySet<TesterUnavailableReason> = new Set<TesterUnavailableReason>([
  "busy",
  "starting",
  "tester_unavailable",
  "connection_refused",
  "name_not_resolved",
  "not_sent",
]);

/** A fetch that rejects as undici does when the socket or the resolver failed with `code`. */
function failingWith(code: string): { doFetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const doFetch = (async () => {
    calls += 1;
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(`getaddrinfo ${code} tester.invalid`), { code }) });
  }) as unknown as typeof fetch;
  return { doFetch, calls: () => calls };
}

const unavailable = (reason: TesterUnavailableReason, details: Record<string, unknown> = {}): TestRunResult =>
  ({ kind: "unavailable", reason, ...details, isReleasable: RELEASED.has(reason) }) as TestRunResult;

describe("the collector tester's client", () => {
  it("gives a run 74 + d s over its request and reply, and reads at most 32 MiB", () => {
    expect(otelcolTestingRunTimeoutMs(1)).toBe(75_000);
    expect(otelcolTestingRunTimeoutMs(60)).toBe(134_000);
    expect(MAX_OTELCOL_TESTING_REPLY_BYTES).toBe(32 * 1024 * 1024);
  });

  describe("the run's duration is guarded in the timer", () => {
    it.each([0, 61, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses %d s: no timer is built from it", (seconds) => {
      expect(isOtelcolTestingDuration(seconds)).toBe(false);
      expect(() => otelcolTestingRunTimeoutMs(seconds)).toThrow(RangeError);
    });

    it.each([0, 61, 2.5, Number.NaN])("a run of %d s: invalid_request, nothing sent, never released, logged", async (seconds) => {
      const log = recordingLog();
      const { seen, doFetch } = answering(() => new Response(JSON.stringify(answerBody()), { status: 200 }));

      expect(await handMade(doFetch, log).run({ ...RUN, durationSeconds: seconds })).toEqual(unavailable("invalid_request"));
      expect(seen).toEqual([]);
      expect(log.lines).toEqual([{ details: { operation: "runTest", reason: "invalid_request" }, message: expect.any(String) }]);
    });

    it("takes 1 and 60", async () => {
      for (const seconds of [1, 60]) {
        const { seen, doFetch } = answering(() => new Response(JSON.stringify(answerBody()), { status: 200 }));
        expect((await handMade(doFetch).run({ ...RUN, durationSeconds: seconds })).kind).toBe("succeeded");
        expect(seen).toHaveLength(1);
      }
    });
  });

  it("releases only the runs the tester refused before starting, or a refused connection", () => {
    expect([...RELEASABLE_TESTER_REASONS].sort()).toEqual([...RELEASED].sort());
  });

  describe("a run the tester ran", () => {
    it("succeeded: the answer, its output decoded to the bytes the tester sent", async () => {
      const result = await client.run(RUN);

      expect(result.kind).toBe("succeeded");
      if (result.kind !== "succeeded") return;
      expect(result.answer).toMatchObject({
        status: "succeeded",
        strategy: "otlp",
        collectorVersion: "0.162.0",
        output: { bytesOnDisk: INPUT.byteLength, truncated: false },
        decodedInput: { truncated: false },
      });
      expect(Buffer.from(result.answer.output!.base64)).toEqual(Buffer.from(INPUT));
      expect(Buffer.from(result.answer.decodedInput!.base64)).toEqual(Buffer.from(INPUT));
    });

    it("sends the run as the contract asks: JSON, the input as base64, the secret as a Bearer token, no redirects", async () => {
      await client.run({ ...RUN, input: INPUT.subarray(2, 10) });
      expect(fake.takeRequests()).toEqual([
        {
          runId: RUN.runId,
          yaml: RUN.yaml,
          pipeline: "logs",
          signal: "logs",
          durationSeconds: 5,
          distribution: "otelcol-contrib",
          version: "0.162.0",
          input: { sizeBytes: 8, sha256: createHash("sha256").update(INPUT.subarray(2, 10)).digest("hex") },
        },
      ]);

      const { seen, doFetch } = answering(() => new Response(JSON.stringify(answerBody()), { status: 200 }));
      await handMade(doFetch).run(RUN);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe("http://tester.invalid/testing/v1/runs");
      expect(seen[0]!.init).toMatchObject({
        method: "POST",
        headers: { authorization: `Bearer ${"s".repeat(32)}`, "content-type": "application/json" },
        redirect: "manual",
      });
      expect(JSON.parse(seen[0]!.init.body as string)).toEqual({
        runId: RUN.runId,
        yaml: RUN.yaml,
        pipeline: "logs",
        signal: "logs",
        durationSeconds: 5,
        distribution: "otelcol-contrib",
        version: "0.162.0",
        input: { base64: Buffer.from(INPUT).toString("base64") },
      });
    });

    it("failed, collector_failed: the answer and its error", async () => {
      const result = await client.run(withMarker("collector-failed"));

      expect(result).toMatchObject({
        kind: "failed",
        error: { code: "collector_failed" },
        answer: { status: "failed", output: null },
      });
    });

    it("failed, refused: a C-0xx refusal, no collector started", async () => {
      const result = await client.run(withMarker("refused"));

      expect(result).toMatchObject({
        kind: "failed",
        error: { code: "refused" },
        answer: { strategy: null, compatibility: [{ id: "C-005", severity: "refuse" }] },
      });
    });
  });

  describe("every other outcome is unavailable, and says whether the run may be released", () => {
    it.each<[string, FakeOtelcolTestingFault, TestRunResult]>([
      ["503 tester_busy", "tester_busy", unavailable("busy", { status: 503, code: "tester_busy" })],
      ["503 tester_starting", "tester_starting", unavailable("starting", { status: 503, code: "tester_starting" })],
      ["503 tester_unavailable", "tester_unavailable", unavailable("tester_unavailable", { status: 503, code: "tester_unavailable" })],
      ["503 version_unavailable", "version_unavailable", unavailable("version_unavailable", { status: 503, code: "version_unavailable" })],
      ["500 internal_error", "error_500", unavailable("http_status", { status: 500, code: "internal_error" })],
      ["409 version_retired", "version_retired", unavailable("version_retired", { status: 409, code: "version_retired" })],
      ["400 version_unknown", "version_unknown", unavailable("version_unknown", { status: 400, code: "version_unknown" })],
      ["400 invalid_request", "invalid_request", unavailable("http_status", { status: 400, code: "invalid_request" })],
      ["413 payload_too_large", "payload_too_large", unavailable("http_status", { status: 413, code: "payload_too_large" })],
      ["413 input_too_large", "input_too_large", unavailable("http_status", { status: 413, code: "input_too_large" })],
    ])("the tester's %s", async (_label, fault, expected) => {
      fake.nextFault(fault);
      expect(await client.run(RUN)).toEqual(expected);
    });

    it("released: busy, starting and tester_unavailable (refused before starting); never released: version_unavailable and 500", async () => {
      const outcomes: Array<[string, boolean]> = [];
      for (const marker of ["busy", "starting", "unavailable", "version-unavailable"] as const) {
        const result = await client.run(withMarker(marker));
        outcomes.push([marker, result.kind === "unavailable" && result.isReleasable]);
      }
      fake.nextFault("error_500");
      const failed = await client.run(RUN);
      outcomes.push(["500", failed.kind === "unavailable" && failed.isReleasable]);

      expect(outcomes).toEqual([
        ["busy", true],
        ["starting", true],
        ["unavailable", true],
        ["version-unavailable", false],
        ["500", false],
      ]);
    });

    it("a secret the tester doesn't take (401): unauthorized, never released, logged at error without the secret or the body", async () => {
      const log = recordingLog();
      const secret = "not-the-fake-otelcol-testing-secret-0123456789";
      const wrong = createOtelcolTestingClient({ url: fake.url, secret, log });

      expect(await wrong.run(RUN)).toEqual(unavailable("unauthorized", { status: 401, code: "unauthorized" }));
      // The envelope's code, never its message or the body.
      expect(log.lines).toEqual([
        {
          details: { operation: "runTest", reason: "unauthorized", status: 401, code: "unauthorized" },
          message: expect.stringContaining("collector tester"),
        },
      ]);
      expect(JSON.stringify(log.lines)).not.toContain(secret);
      expect(JSON.stringify(log.lines)).not.toContain("credentials");
    });

    it("an answer the contract refuses: malformed_reply, never released, logged at error", async () => {
      const log = recordingLog();
      const logged = createOtelcolTestingClient({ url: fake.url, secret: fake.secret, log });
      fake.nextFault("malformed_reply");

      expect(await logged.run(RUN)).toEqual(unavailable("malformed_reply", { status: 200 }));
      // The fake saw its own reply break the contract.
      expect(fake.takeViolations()).toEqual([expect.stringContaining("runTest reply 200 body")]);
      expect(log.lines).toEqual([{ details: { operation: "runTest", reason: "malformed_reply", status: 200 }, message: expect.any(String) }]);
    });

    it.each<[string, FakeOtelcolTestingFault, number, string]>([
      ["500 internal_error", "error_500", 500, "internal_error"],
      ["400 invalid_request", "invalid_request", 400, "invalid_request"],
      ["413 input_too_large", "input_too_large", 413, "input_too_large"],
    ])("a status the run doesn't expect (%s) is logged at error with the envelope's code", async (_label, fault, status, code) => {
      const log = recordingLog();
      const logged = createOtelcolTestingClient({ url: fake.url, secret: fake.secret, log });
      fake.nextFault(fault);

      await logged.run(RUN);
      expect(log.lines).toEqual([{ details: { operation: "runTest", reason: "http_status", status, code }, message: expect.any(String) }]);
      expect(log.warnings).toEqual([]);
      // The envelope's message stays out.
      expect(JSON.stringify(log.lines)).not.toMatch(/Internal server error|retired:|JSON object|larger than/);
    });

    it.each<[string, FakeOtelcolTestingFault, number, string, TesterUnavailableReason]>([
      ["409 version_retired", "version_retired", 409, "version_retired", "version_retired"],
      ["400 version_unknown", "version_unknown", 400, "version_unknown", "version_unknown"],
    ])("a version the tester doesn't offer (%s): its own reason, never released, logged at warn, not error", async (_label, fault, status, code, reason) => {
      const log = recordingLog();
      const logged = createOtelcolTestingClient({ url: fake.url, secret: fake.secret, log });
      fake.nextFault(fault);

      const result = await logged.run(RUN);

      expect(result).toEqual(unavailable(reason, { status, code }));
      expect(result.kind === "unavailable" && result.isReleasable).toBe(false);
      expect(log.lines).toEqual([]);
      expect(log.warnings).toEqual([{ details: { operation: "runTest", reason, status, code }, message: expect.any(String) }]);
      expect(JSON.stringify(log.warnings)).not.toMatch(/retired:|no such version/);
    });

    it("a 409 or a 400 with another code is not a retired version", async () => {
      fake.nextFault("invalid_request");
      expect(await client.run(RUN)).toEqual(unavailable("http_status", { status: 400, code: "invalid_request" }));
    });

    it("a 503 the dispatcher handles (busy, version_unavailable) is not logged", async () => {
      const log = recordingLog();
      const logged = createOtelcolTestingClient({ url: fake.url, secret: fake.secret, log });
      fake.nextFault("tester_busy");
      fake.nextFault("version_unavailable");
      await logged.run(RUN);
      await logged.run(RUN);
      expect(log.lines).toEqual([]);
    });

    it.each([
      ["not JSON", "<html>oops</html>"],
      ["failed without an error", JSON.stringify(answerBody({ status: "failed" }))],
      ["succeeded with an error", JSON.stringify(answerBody({ error: { code: "refused", message: "x" } }))],
      ["an error code it doesn't know", JSON.stringify(answerBody({ status: "failed", error: { code: "exploded", message: "x" } }))],
      ["an output that isn't standard base64", JSON.stringify(answerBody({ output: { base64: "b3V0", bytesOnDisk: 3, truncated: false }, decodedInput: { base64: "b3V0\n", truncated: false } }))],
      ["an output over 10 MiB decoded", JSON.stringify(answerBody({ output: { base64: Buffer.alloc(10 * 1024 * 1024 + 3).toString("base64"), bytesOnDisk: 1, truncated: false } }))],
      ["a negative timing", JSON.stringify(answerBody({ timings: { totalMs: -1, readyMs: null, informerMs: null, replayMs: null, holdMs: null, stopMs: null } }))],
      ["logs over 256 KiB", JSON.stringify(answerBody({ logs: "x".repeat(262_145) }))],
      ["another version's answer", JSON.stringify(answerBody({ collectorVersion: "0.161.0" }))],
    ])("a 200 that is %s: malformed_reply", async (_label, body) => {
      const { doFetch } = answering(() => new Response(body, { status: 200 }));
      expect(await handMade(doFetch).run(RUN)).toEqual(unavailable("malformed_reply", { status: 200 }));
    });

    it("reads logs of 256 KiB counted in characters, as the contract counts them", async () => {
      // 262,144 characters, each two UTF-16 units.
      const { doFetch } = answering(() => new Response(JSON.stringify(answerBody({ logs: "😀".repeat(262_144) })), { status: 200 }));
      expect((await handMade(doFetch).run(RUN)).kind).toBe("succeeded");
    });

    it.each([
      ["a redirect, never followed", 302, { location: "http://elsewhere.invalid/" }],
      ["a 2xx other than 200", 204, {}],
      ["a 502", 502, {}],
      ["a 503 without the envelope", 503, {}],
    ] as const)("%s: http_status, never released", async (_label, status, headers) => {
      const { seen, doFetch } = answering(() => new Response(status === 204 ? null : "{}", { status, headers }));

      expect(await handMade(doFetch).run(RUN)).toEqual(unavailable("http_status", { status }));
      expect(seen).toHaveLength(1);
    });

    it("nothing listening: connection_refused, released (nothing was sent)", async () => {
      const down = createOtelcolTestingClient({ url: await closedUrl(), secret: fake.secret });
      expect(await down.run(RUN)).toEqual({ kind: "unavailable", reason: "connection_refused", isReleasable: true });
    });

    it.each(["ENOTFOUND", "EAI_AGAIN"])("the tester's name doesn't resolve (%s): name_not_resolved, released (nothing was sent)", async (code) => {
      const { doFetch, calls } = failingWith(code);
      expect(await handMade(doFetch).run(RUN)).toEqual({ kind: "unavailable", reason: "name_not_resolved", isReleasable: true });
      expect(calls()).toBe(1);
    });

    it("any other socket error before an answer: network, never released", async () => {
      const { doFetch } = failingWith("ECONNRESET");
      expect(await handMade(doFetch).run(RUN)).toEqual({ kind: "unavailable", reason: "network", isReleasable: false });
    });

    it("a connection reset after the run was sent: network, never released", async () => {
      fake.nextFault("reset");
      expect(await client.run(RUN)).toEqual({ kind: "unavailable", reason: "network", isReleasable: false });
    });

    it("no answer within 74 + d s: timeout, never released (fake timers)", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { doFetch, calls } = neverAnswering();
      let settled: TestRunResult | undefined;
      const pending = handMade(doFetch)
        .run({ ...RUN, durationSeconds: 7 })
        .then((result) => {
          settled = result;
        });

      await vi.advanceTimersByTimeAsync(81_000 - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toEqual({ kind: "unavailable", reason: "timeout", isReleasable: false });
      expect(calls()).toBe(1);
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
      let settled: TestRunResult | undefined;
      const pending = handMade(doFetch)
        .run(RUN)
        .then((result) => {
          settled = result;
        });

      await vi.advanceTimersByTimeAsync(otelcolTestingRunTimeoutMs(RUN.durationSeconds) - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toEqual(unavailable("timeout"));
    });

    it("the caller's signal ended before the call (the API stopping): not_sent, nothing sent, released", async () => {
      const controller = new AbortController();
      controller.abort();
      const { seen, doFetch } = answering(() => new Response(JSON.stringify(answerBody()), { status: 200 }));
      expect(await handMade(doFetch).run(RUN, { signal: controller.signal })).toEqual(unavailable("not_sent"));
      expect(seen).toEqual([]);
    });

    it("the caller's signal (the API shutting down): aborted, never released", async () => {
      const controller = new AbortController();
      const { doFetch } = neverAnswering();
      const pending = handMade(doFetch).run(RUN, { signal: controller.signal });
      controller.abort();

      expect(await pending).toEqual(unavailable("aborted"));
    });

    describe("a reply is read up to a cap", () => {
      it("reads a reply at the cap", async () => {
        const body = JSON.stringify(answerBody()).padEnd(2048, " ");
        const { doFetch } = answering(() => new Response(body, { status: 200 }));
        expect((await handMade(doFetch, undefined, 2048).run(RUN)).kind).toBe("succeeded");
      });

      it("a streamed reply one byte over the cap: oversized_reply, never released, logged, and the rest never read", async () => {
        const log = recordingLog();
        const encoded = new TextEncoder().encode(JSON.stringify(answerBody()).padEnd(2049, " "));
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

        expect(await handMade(doFetch, log, 2048).run(RUN)).toEqual(unavailable("oversized_reply", { status: 200 }));
        expect(cancelled).toBe(true);
        expect(pulls).toBeLessThan(100);
        expect(log.lines).toEqual([{ details: { operation: "runTest", reason: "oversized_reply", status: 200 }, message: expect.any(String) }]);
      });

      it("a declared Content-Length over the cap: oversized_reply, nothing read", async () => {
        const { doFetch } = answering(
          () => new Response(JSON.stringify(answerBody()), { status: 200, headers: { "content-length": "2049" } }),
        );
        expect(await handMade(doFetch, undefined, 2048).run(RUN)).toEqual(unavailable("oversized_reply", { status: 200 }));
      });
    });

    it("never puts the secret, the text or the input in a result or a log line", async () => {
      const secret = "secret-that-must-never-appear-0123456789";
      const log = recordingLog();
      const run = { ...RUN, yaml: "marker-in-the-text: 1\n" };
      const results = [
        await createOtelcolTestingClient({ url: fake.url, secret, log }).run(run),
        await createOtelcolTestingClient({ url: await closedUrl(), secret, log }).run(run),
      ];
      fake.nextFault("malformed_reply");
      results.push(await createOtelcolTestingClient({ url: fake.url, secret: fake.secret, log }).run(run));
      fake.takeViolations();
      fake.nextFault("error_500");
      results.push(await createOtelcolTestingClient({ url: fake.url, secret: fake.secret, log }).run(run));
      results.push(await createOtelcolTestingClient({ url: fake.url, secret: fake.secret, log }).run({ ...run, durationSeconds: 0 }));
      expect(log.lines.length).toBeGreaterThanOrEqual(4);
      for (const shown of [JSON.stringify(results), JSON.stringify(log.lines)]) {
        expect(shown).not.toContain(secret);
        expect(shown).not.toContain("marker-in-the-text");
        expect(shown).not.toContain("input-marker");
        expect(shown).not.toContain(Buffer.from(INPUT).toString("base64"));
      }
    });
  });

  describe("health", () => {
    it("200: up", async () => {
      expect(await client.health()).toEqual({ kind: "up" });
    });

    it.each([
      ["starting", { kind: "down", reason: "starting", status: 503 }],
      ["unavailable", { kind: "down", reason: "kwok_failed", status: 503 }],
    ] as const)("503 %s: down", async (health, expected) => {
      fake.setHealth(health);
      try {
        expect(await client.health()).toEqual(expected);
      } finally {
        fake.setHealth("ready");
      }
    });

    it("asks without the secret, and follows no redirect", async () => {
      const { seen, doFetch } = answering(() => new Response(JSON.stringify({ status: "ok", kwok: "ready" }), { status: 200 }));
      await handMade(doFetch).health();
      expect(seen[0]!.url).toBe("http://tester.invalid/testing/v1/health");
      expect(seen[0]!.init).toMatchObject({ method: "GET", redirect: "manual" });
      expect(JSON.stringify(seen[0]!.init.headers)).not.toContain("s".repeat(32));
    });

    it("nothing listening: down, connection_refused", async () => {
      const down = createOtelcolTestingClient({ url: await closedUrl(), secret: fake.secret });
      expect(await down.health()).toEqual({ kind: "down", reason: "connection_refused" });
    });

    it.each(["ENOTFOUND", "EAI_AGAIN"])("a name that doesn't resolve (%s): down, name_not_resolved", async (code) => {
      expect(await handMade(failingWith(code).doFetch).health()).toEqual({ kind: "down", reason: "name_not_resolved" });
    });

    it.each([
      ["a 200 the contract doesn't give", 200, '{"status":"ok"}', { kind: "down", reason: "malformed_reply", status: 200 }],
      ["a 503 the contract doesn't give", 503, "busy", { kind: "down", reason: "http_status", status: 503 }],
      ["a 500", 500, "{}", { kind: "down", reason: "http_status", status: 500 }],
      ["a redirect", 302, "", { kind: "down", reason: "http_status", status: 302 }],
      [
        "a 503 version_unavailable envelope, which is no health failure",
        503,
        JSON.stringify({ error: { code: "version_unavailable", message: "x" } }),
        { kind: "version_unavailable" },
      ],
    ] as const)("%s", async (_label, status, body, expected) => {
      const { doFetch } = answering(() => new Response(body === "" ? null : body, { status }));
      expect(await handMade(doFetch).health()).toEqual(expected);
    });

    it("no answer within 5 s: down, timeout (fake timers)", async () => {
      expect(OTELCOL_TESTING_HEALTH_TIMEOUT_MS).toBe(5_000);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { doFetch } = neverAnswering();
      let settled: unknown;
      const pending = handMade(doFetch)
        .health()
        .then((result) => {
          settled = result;
        });

      await vi.advanceTimersByTimeAsync(OTELCOL_TESTING_HEALTH_TIMEOUT_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toEqual({ kind: "down", reason: "timeout" });
    });
  });
});
