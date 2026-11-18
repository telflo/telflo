import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fakeOtelcolTestingMarker,
  startFakeOtelcolTesting,
  type FakeOtelcolTesting,
  type FakeOtelcolTestingFault,
} from "./fake-otelcol-testing.js";

// The fake collector tester's own contract checks (D14a Task 6): it must
// catch a request that breaks services/otelcol-testing/openapi.yaml, and a
// reply of its own that does, or the client's and the API's tests against it
// prove nothing; and it must answer by the text, as the browser tests rely
// on. These tests send raw requests, shaped as the client's are, then broken.

let fake: FakeOtelcolTesting;

beforeAll(async () => {
  fake = await startFakeOtelcolTesting();
});

afterEach(() => {
  expect(fake.takeViolations()).toEqual([]);
  fake.takeRequests();
  fake.setHealth("ready");
});

afterAll(async () => {
  await fake.close();
});

const runsUrl = () => `${fake.url}/testing/v1/runs`;

const INPUT = '{"resourceLogs":[]}';

/** A run request that keeps the contract; `overrides` replaces fields (undefined removes one). */
function runBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    runId: "0190f5c2-7d1a-7c4e-8a3b-4f2e3d4c5b6a",
    yaml: "receivers:\n  otlp: {}\n",
    pipeline: "logs",
    signal: "logs",
    durationSeconds: 5,
    distribution: "otelcol-contrib",
    version: "0.162.0",
    input: { base64: Buffer.from(INPUT).toString("base64") },
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete body[key];
  return body;
}

function post(body: unknown, headers: Record<string, string> = {}, url = runsUrl(), raw?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

function withMarker(marker: Parameters<typeof fakeOtelcolTestingMarker>[0], yaml = "receivers:\n  otlp: {}\n"): string {
  return `${yaml}${fakeOtelcolTestingMarker(marker)}\n`;
}

describe("the fake otelcol-testing's request validation", () => {
  it("accepts a request that keeps the contract, with no violation, and records what it read (the input as a size and a hash)", async () => {
    const response = await post(runBody());

    expect(response.status).toBe(200);
    expect(fake.takeViolations()).toEqual([]);
    expect(fake.takeRequests()).toEqual([
      {
        runId: "0190f5c2-7d1a-7c4e-8a3b-4f2e3d4c5b6a",
        yaml: "receivers:\n  otlp: {}\n",
        pipeline: "logs",
        signal: "logs",
        durationSeconds: 5,
        distribution: "otelcol-contrib",
        version: "0.162.0",
        input: { sizeBytes: INPUT.length, sha256: createHash("sha256").update(INPUT).digest("hex") },
      },
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["no runId", { runId: undefined }],
    ["a runId that isn't a UUID", { runId: "run-1" }],
    ["an empty yaml", { yaml: "" }],
    ["no pipeline", { pipeline: undefined }],
    ["an unknown signal", { signal: "profiles" }],
    ["a duration of 0", { durationSeconds: 0 }],
    ["a duration of 61", { durationSeconds: 61 }],
    ["a duration that isn't an integer", { durationSeconds: 1.5 }],
    ["another distribution", { distribution: "otelcol-core" }],
    ["a version that isn't major.minor.patch", { version: "latest" }],
    ["no input", { input: undefined }],
    ["an input that isn't an object", { input: "aGk=" }],
    ["an input with a file name", { input: { base64: "aGk=", name: "sample.json" } }],
    ["a field the API doesn't know", { fileName: "sample.json" }],
  ])("catches %s, answering 400", async (_label, overrides) => {
    const response = await post(runBody(overrides));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(fake.takeViolations()).toEqual([expect.stringContaining("runTest request body")]);
  });

  it.each(["aGk", "a GVsbG8=", "aGk=\n", "!!!!"])("catches an input %j that isn't standard base64, answering 400", async (base64) => {
    const response = await post(runBody({ input: { base64 } }));

    expect(response.status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("/input/base64 isn't standard base64")]);
  });

  it("catches a yaml over 262,144 characters, answering 413 as the real tester does", async () => {
    const response = await post(runBody({ yaml: "#".repeat(262_145) }));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
    expect(fake.takeViolations()).toEqual([expect.stringContaining("more than 262144 characters")]);
  });

  it("catches an input over 10 MiB decoded, answering 413 input_too_large", async () => {
    const response = await post(runBody({ input: { base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") } }));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "input_too_large" } });
    // The file's maxLength and the decoded size both say so.
    expect(fake.takeViolations().join("\n")).toContain("larger than 10 MiB decoded");
  });

  it("catches a body that isn't JSON, and the wrong Content-Type", async () => {
    expect((await post(undefined, {}, runsUrl(), "{not json")).status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("isn't JSON")]);

    expect((await post(runBody(), { "content-type": "text/plain" })).status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("Content-Type")]);
  });

  it("catches the secret sent without the Bearer scheme, and answers 401 with WWW-Authenticate", async () => {
    const response = await post(runBody(), { authorization: fake.secret });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(fake.takeViolations()).toEqual([expect.stringContaining("no Authorization: Bearer header")]);
    expect(fake.takeRequests()).toEqual([]);
  });

  it("answers a wrong secret 401 without a violation: that is a documented answer", async () => {
    const response = await post(runBody(), { authorization: "Bearer not-the-fake-secret-not-the-fake-secret" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid credentials." } });
    expect(fake.takeViolations()).toEqual([]);
  });

  it("catches a route the file doesn't document: a method, a path, a query", async () => {
    const get = await fetch(runsUrl(), { headers: { authorization: `Bearer ${fake.secret}` } });
    expect(get.status).toBe(404);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("the route isn't documented")]);

    const other = await post(runBody(), {}, `${fake.url}/testing/v1/run`);
    expect(other.status).toBe(404);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("the route isn't documented")]);

    expect((await post(runBody(), {}, `${runsUrl()}?debug=1`)).status).toBe(200);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("has a query")]);
  });
});

describe("the fake otelcol-testing's health", () => {
  it("answers ready without the secret, as documented", async () => {
    const response = await fetch(`${fake.url}/testing/v1/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", kwok: "ready" });
  });

  it.each([
    ["starting", { status: "starting", kwok: "starting" }],
    ["unavailable", { status: "unavailable", kwok: "failed" }],
  ] as const)("answers 503 %s once set, as documented, until set back", async (health, body) => {
    fake.setHealth(health);
    const response = await fetch(`${fake.url}/testing/v1/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(body);

    fake.setHealth("ready");
    expect((await fetch(`${fake.url}/testing/v1/health`)).status).toBe(200);
  });

  it("catches a health request with a query", async () => {
    expect((await fetch(`${fake.url}/testing/v1/health?verbose=1`)).status).toBe(200);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("has a query")]);
  });
});

describe("the fake otelcol-testing's answers by the text", () => {
  it("succeeds by default, its output and decoded input the input's own bytes, for the version asked", async () => {
    const response = await post(runBody({ version: "1.2.3", durationSeconds: 7 }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "succeeded",
      strategy: "otlp",
      kwokEnabled: false,
      collectorVersion: "1.2.3",
      output: { base64: Buffer.from(INPUT).toString("base64"), bytesOnDisk: INPUT.length, truncated: false },
      decodedInput: { base64: Buffer.from(INPUT).toString("base64"), truncated: false },
      timings: { holdMs: 7000 },
    });
    expect(body).not.toHaveProperty("error");
  });

  it("answers an empty input with no output", async () => {
    const body = (await (await post(runBody({ input: { base64: "" } }))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "succeeded", output: null, decodedInput: { base64: "", truncated: false } });
  });

  it("fails collector_failed for the collector-failed marker", async () => {
    const body = (await (await post(runBody({ yaml: withMarker("collector-failed") }))).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ status: "failed", error: { code: "collector_failed" }, output: null });
  });

  it("refuses for the refused marker, with a C-0xx refusal and no collector started", async () => {
    const body = (await (await post(runBody({ yaml: withMarker("refused") }))).json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      status: "failed",
      error: { code: "refused" },
      strategy: null,
      mutatedYaml: null,
      compatibility: [{ id: expect.stringMatching(/^C-0\d\d$/), severity: "refuse" }],
      output: null,
    });
  });

  it.each([
    ["busy", "tester_busy"],
    ["starting", "tester_starting"],
    ["unavailable", "tester_unavailable"],
    ["version-unavailable", "version_unavailable"],
  ] as const)("answers 503 for the %s marker, %s", async (marker, code) => {
    const response = await post(runBody({ yaml: withMarker(marker) }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it("reads a marker only on a line of its own", async () => {
    const body = (await (await post(runBody({ yaml: `x: "${fakeOtelcolTestingMarker("busy")}"\n` }))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "succeeded" });
  });

  it("holds a slow run until released, by a condition, then answers it as the rest of its text asks", async () => {
    const first = post(runBody({ yaml: withMarker("slow") }));
    const second = post(runBody({ yaml: withMarker("slow", withMarker("collector-failed")) }));
    await fake.waitForHeld(2);
    expect(fake.heldCount()).toBe(2);

    expect(fake.releaseHeld()).toBe(2);
    expect(fake.heldCount()).toBe(0);
    expect(await (await first).json()).toMatchObject({ status: "succeeded" });
    expect(await (await second).json()).toMatchObject({ status: "failed", error: { code: "collector_failed" } });
    expect(fake.releaseHeld()).toBe(0);
  });

  it("counts, waits for and releases only the held runs whose text holds `contains`, when given", async () => {
    const mine = post(runBody({ yaml: withMarker("slow", "# run: mine\n") }));
    const theirs = post(runBody({ yaml: withMarker("slow", "# run: theirs\n") }));
    await fake.waitForHeld(1, "# run: mine");
    await fake.waitForHeld(2);
    expect(fake.heldCount("# run: mine")).toBe(1);
    expect(fake.heldCount("# run: nobody")).toBe(0);

    expect(fake.releaseHeld("# run: mine")).toBe(1);
    expect(await (await mine).json()).toMatchObject({ status: "succeeded" });
    expect(fake.heldCount()).toBe(1);
    expect(fake.heldCount("# run: theirs")).toBe(1);

    expect(fake.releaseHeld()).toBe(1);
    expect(await (await theirs).json()).toMatchObject({ status: "succeeded" });
  });
});

describe("the fake otelcol-testing's changes-attributes marker (D15b Preflight ruling 6)", () => {
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  /** A record's attributes before the run: one kept, one changed, one removed. */
  const before = () => [attribute("kept", "k"), attribute("e2e.changed", "before"), attribute("e2e.removed", "gone")];
  /** The same record's, after. */
  const after = [attribute("kept", "k"), attribute("e2e.changed", "after"), attribute("e2e.added", "yes")];

  async function run(input: string, yaml = withMarker("changes-attributes")) {
    const response = await post(runBody({ yaml, input: { base64: Buffer.from(input).toString("base64") } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      output: { base64: string; bytesOnDisk: number; truncated: boolean } | null;
      decodedInput: { base64: string; truncated: boolean };
    };
    expect(fake.takeViolations()).toEqual([]);
    expect(body.status).toBe("succeeded");
    // The decoded input is always the input's own bytes.
    expect(body.decodedInput).toEqual({ base64: Buffer.from(input).toString("base64"), truncated: false });
    const output = Buffer.from(body.output?.base64 ?? "", "base64");
    expect(body.output?.bytesOnDisk).toBe(output.byteLength);
    expect(body.output?.truncated).toBe(false);
    return output.toString("utf8");
  }

  it.each([
    [
      "logs: every log record, across resources and scopes",
      (records: () => unknown[]) => ({
        resourceLogs: [{ scopeLogs: [{ logRecords: records() }, { logRecords: records() }] }, { scopeLogs: [{ logRecords: records() }] }],
      }),
    ],
    ["traces: every span", (records: () => unknown[]) => ({ resourceSpans: [{ scopeSpans: [{ spans: records() }] }] })],
    [
      "metrics: every metric type's data points",
      (records: () => unknown[]) => ({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  { name: "g", gauge: { dataPoints: records() } },
                  { name: "s", sum: { dataPoints: records() } },
                  { name: "h", histogram: { dataPoints: records() } },
                  { name: "e", exponentialHistogram: { dataPoints: records() } },
                  { name: "m", summary: { dataPoints: records() } },
                ],
              },
            ],
          },
        ],
      }),
    ],
  ] as const)("changes %s, written as compact JSON, with no violation", async (_signal, document) => {
    const input = JSON.stringify(document(() => [{ attributes: before() }, { attributes: before(), name: "n" }]), null, 2);

    const output = await run(input);

    expect(output).toBe(JSON.stringify(document(() => [{ attributes: after }, { attributes: after, name: "n" }])));
  });

  it("adds e2e.added to a record with no attributes, and sets an existing one to yes", async () => {
    const input = { resourceLogs: [{ scopeLogs: [{ logRecords: [{}, { attributes: [attribute("e2e.added", "no")] }] }] }] };

    expect(JSON.parse(await run(JSON.stringify(input)))).toEqual({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [attribute("e2e.added", "yes")] }, { attributes: [attribute("e2e.added", "yes")] }] }] }],
    });
  });

  it.each([
    ["text that isn't JSON", "not json at all"],
    ["JSON that isn't OTLP", '{"records":[{"attributes":[]}]}'],
    ["a JSON array of documents", '[{"resourceLogs":[]}]'],
    ["NDJSON", '{"resourceLogs":[]}\n{"resourceLogs":[]}\n'],
  ])("passes %s through unchanged", async (_label, input) => {
    expect(await run(input)).toBe(input);
  });

  it("passes the input through unchanged when its output would pass 10 MiB", async () => {
    // 200,000 empty records: about 600 KB in, over 12 MiB once each gains e2e.added.
    const input = JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: Array.from({ length: 200_000 }, () => ({})) }] }] });

    expect(await run(input)).toBe(input);
  });

  it("reads the marker only on a line of its own", async () => {
    const input = JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: before() }] }] }] }, null, 2);

    expect(await run(input, `x: "${fakeOtelcolTestingMarker("changes-attributes")}"\n`)).toBe(input);
    expect(await run(input, "receivers:\n  otlp: {}\n")).toBe(input);
  });
});

describe("the fake otelcol-testing's faults", () => {
  it.each<[FakeOtelcolTestingFault, number, string]>([
    ["error_500", 500, "internal_error"],
    ["tester_busy", 503, "tester_busy"],
    ["tester_starting", 503, "tester_starting"],
    ["tester_unavailable", 503, "tester_unavailable"],
    ["version_unavailable", 503, "version_unavailable"],
    ["version_retired", 409, "version_retired"],
    ["invalid_request", 400, "invalid_request"],
    ["payload_too_large", 413, "payload_too_large"],
    ["input_too_large", 413, "input_too_large"],
  ])("answers %s once, as documented, with no violation", async (fault, status, code) => {
    fake.nextFault(fault);
    const response = await post(runBody());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });

    expect((await post(runBody())).status).toBe(200);
  });

  it("queues faults: each run takes the first waiting, in order", async () => {
    fake.nextFault("tester_busy");
    fake.nextFault("tester_starting");
    fake.nextFault("error_500");

    const codes = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await post(runBody());
      codes.push(response.status === 200 ? "ok" : ((await response.json()) as { error: { code: string } }).error.code);
    }
    expect(codes).toEqual(["tester_busy", "tester_starting", "internal_error", "ok"]);
  });

  it("never faults the health check", async () => {
    fake.nextFault("error_500");
    expect((await fetch(`${fake.url}/testing/v1/health`)).status).toBe(200);
    expect((await post(runBody())).status).toBe(500);
  });

  it("catches its own malformed reply as a violation", async () => {
    fake.nextFault("malformed_reply");
    const response = await post(runBody());

    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("status");
    expect(fake.takeViolations()).toEqual([expect.stringContaining("runTest reply 200 body")]);
  });

  it("resets the connection", async () => {
    fake.nextFault("reset");
    await expect(post(runBody())).rejects.toThrow();
    expect((await post(runBody())).status).toBe(200);
  });
});

describe("the fake otelcol-testing's close", () => {
  it("rejects while a violation is unread, so a test that forgets to look still fails", async () => {
    const own = await startFakeOtelcolTesting();
    await fetch(`${own.url}/testing/v1/runs`, { method: "POST", body: "{}" });

    await expect(own.close()).rejects.toThrow(/contract violations no test read/);
  });

  it("ends a run it holds (hang, slow) when it closes", async () => {
    const own = await startFakeOtelcolTesting();
    const send = (yaml: string) =>
      fetch(`${own.url}/testing/v1/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${own.secret}`, "content-type": "application/json" },
        body: JSON.stringify(runBody({ yaml })),
      });
    const outcome = (pending: Promise<Response>) => pending.then(() => "answered", () => "ended");
    own.nextFault("hang");
    const hung = outcome(send("a: 1\n"));
    const slow = outcome(send(withMarker("slow")));
    await own.waitForHeld(1);
    // The hung request was read first: the fake records each as it reads it.
    expect(own.takeRequests()).toHaveLength(2);

    await own.close();
    expect(await hung).toBe("ended");
    expect(await slow).toBe("ended");
  });
});

describe("the fake otelcol-testing's options", () => {
  it("listens on the port it is given, as the browser tests' does (28087)", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const own = await startFakeOtelcolTesting({ port });
    expect(own.url).toBe(`http://127.0.0.1:${port}`);
    await own.close();
  });

  it("refuses to start on a port that is taken, rather than hanging", async () => {
    const port = Number(new URL(fake.url).port);
    await expect(startFakeOtelcolTesting({ port })).rejects.toThrow(/EADDRINUSE/);
  });

  it("tells onViolation each violation as it records it, and still keeps it for takeViolations", async () => {
    const told: string[] = [];
    const own = await startFakeOtelcolTesting({ onViolation: (message) => told.push(message) });
    await fetch(`${own.url}/testing/v1/runs`, { method: "POST", body: "{}" });

    expect(told).toEqual([expect.stringContaining("no Authorization: Bearer header")]);
    expect(own.takeViolations()).toEqual(told);
    await own.close();
  });
});
