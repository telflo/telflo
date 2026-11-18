import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  startFakeOtelcolValidator,
  type FakeOtelcolValidator,
  type FakeOtelcolValidatorFault,
} from "../testing/fake-otelcol-validator.js";
import {
  createOtelcolValidatorClient,
  DEFAULT_OTELCOL_VALIDATOR_TIMEOUT_MS,
  MAX_OTELCOL_VALIDATOR_REPLY_BYTES,
  type OtelcolValidatorClient,
  type ValidatorUnavailableReason,
} from "./client.js";

// The platform's client for the collector validator (D13b decisions 11 and
// 12, Preflight ruling 18, Ruling 32), against the OpenAPI-checked fake, and
// against a hand-made fetch for what the fake can't be pushed to answer.
// Every failure is `unavailable`, never a throw.

let fake: FakeOtelcolValidator;
let client: OtelcolValidatorClient;

beforeAll(async () => {
  fake = await startFakeOtelcolValidator();
  client = createOtelcolValidatorClient({ url: `${fake.url}/`, secret: fake.secret });
});

afterEach(() => {
  expect(fake.takeViolations()).toEqual([]);
  fake.takeRequests();
});

afterAll(async () => {
  await fake.close();
});

const CHECK = { distribution: "otelcol-contrib", version: "0.162.0", yaml: "receivers:\n  otlp: {}\n" };

/** A fetch that answers `response` and records what it was asked. */
function answering(response: () => Response | Promise<Response>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return response();
  }) as unknown as typeof fetch;
  return { seen, doFetch };
}

/** The port of a server that just closed: nothing listens there. */
async function closedUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe("the collector validator's client", () => {
  it("waits 20 s by default (Ruling 32: a queued check's 5 s and its 12 s deadline)", () => {
    expect(DEFAULT_OTELCOL_VALIDATOR_TIMEOUT_MS).toBe(20_000);
  });

  it("checks a text the collector accepts: checked, valid, with its requirements", async () => {
    const result = await client.validate({ ...CHECK, yaml: 'exporters:\n  debug:\n    x: "${env:TOKEN}"\n' });

    expect(result).toEqual({
      kind: "checked",
      valid: true,
      errors: [],
      requirements: [
        {
          category: "env_var",
          title: "Set environment variable TOKEN",
          description: expect.stringContaining("${env:TOKEN}"),
          componentPath: null,
        },
      ],
    });
  });

  it("checks a text the collector refuses: checked, invalid, with its errors", async () => {
    const result = await client.validate({ ...CHECK, yaml: "exporters:\n  unknown_sink/2: {}\n" });

    expect(result).toEqual({
      kind: "checked",
      valid: false,
      errors: [{ message: 'unknown type: "unknown_sink" for id: "unknown_sink/2"', componentPath: "exporters::unknown_sink/2" }],
      requirements: [],
    });
  });

  it("sends the distribution and the version in the path, the text alone in the body, and the secret as a Bearer token", async () => {
    await client.validate({ ...CHECK, distribution: "fixture-build", version: "1.2.3" });
    expect(fake.takeRequests()).toEqual([{ distribution: "fixture-build", version: "1.2.3", yaml: CHECK.yaml }]);

    const { seen, doFetch } = answering(
      () =>
        new Response(JSON.stringify({ valid: true, errors: [], requirements: [], ...{ distribution: "a", version: "1.0.0" } }), {
          status: 200,
        }),
    );
    await createOtelcolValidatorClient({ url: "http://validator.invalid", secret: "s".repeat(32), fetch: doFetch }).validate({
      distribution: "a",
      version: "1.0.0",
      yaml: "x: 1\n",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://validator.invalid/validator/v1/validate/a/1.0.0");
    expect(seen[0]!.init).toMatchObject({
      method: "POST",
      headers: { authorization: `Bearer ${"s".repeat(32)}`, "content-type": "application/json" },
      body: JSON.stringify({ yaml: "x: 1\n" }),
      redirect: "manual",
    });
  });

  describe("the organization's values (D20 decisions 13 and 27; platform choice P2)", () => {
    it("sends them in the body, by name, in their order; a variable named __proto__ like any other", async () => {
      const values = new Map([
        ["HOST", "a$b.example"],
        ["__proto__", "kept"],
        ["A", ""],
      ]);
      const { seen, doFetch } = answering(
        () =>
          new Response(JSON.stringify({ valid: true, errors: [], requirements: [], distribution: "a", version: "1.0.0" }), {
            status: 200,
          }),
      );
      await createOtelcolValidatorClient({ url: "http://validator.invalid", secret: "s".repeat(32), fetch: doFetch }).validate({
        distribution: "a",
        version: "1.0.0",
        yaml: "x: ${org:HOST}\n",
        organizationVariables: values,
      });

      expect(seen[0]!.init.body).toBe(
        '{"yaml":"x: ${org:HOST}\\n","organizationVariables":{"HOST":"a$b.example","__proto__":"kept","A":""}}',
      );
    });

    it("sends the text alone when there are none", async () => {
      await client.validate({ ...CHECK, organizationVariables: new Map() });
      await client.validate({ ...CHECK, organizationVariables: undefined });

      const requests = fake.takeRequests();
      expect(requests).toHaveLength(2);
      for (const request of requests) expect(request.organizationVariables).toBeUndefined();
    });

    it("sends a text and 150 values at their longest unescaped (Q104), under the validator's 2 MiB, and the fake takes them", async () => {
      const values = new Map(
        Array.from({ length: 150 }, (_, index) => [`V${String(index).padStart(3, "0")}${"_".repeat(124)}`, "\u{1F680}".repeat(1024)]),
      );
      // A text of 262,144 UTF-16 units (the platform's limit) at its most
      // bytes: three-byte characters, each one unit.
      const head = "receivers:\n  otlp: {}\n# ";
      const yaml = `${head}${"\u20ac".repeat(262_144 - head.length - 1)}\n`;
      expect(yaml).toHaveLength(262_144);
      const { seen, doFetch } = answering(() => new Response("{}", { status: 500 }));
      await createOtelcolValidatorClient({ url: "http://validator.invalid", secret: "s".repeat(32), fetch: doFetch }).validate({
        ...CHECK,
        yaml,
        organizationVariables: values,
      });
      const bytes = Buffer.byteLength(seen[0]!.init.body as string, "utf8");
      expect(bytes).toBeGreaterThan(1_400_000);
      expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);

      const result = await client.validate({ ...CHECK, yaml, organizationVariables: values });

      expect(result).toMatchObject({ kind: "checked", valid: true });
      const [request] = fake.takeRequests();
      expect(Object.keys(request!.organizationVariables!)).toHaveLength(150);
    });
  });

  describe("every failure is unavailable (Preflight ruling 18)", () => {
    it.each<[FakeOtelcolValidatorFault, ValidatorUnavailableReason, number]>([
      ["invalid_request", "invalid_request", 400],
      ["not_found", "not_found", 404],
      ["version_retired", "version_retired", 409],
      ["payload_too_large", "payload_too_large", 413],
      ["error_500", "server_error", 500],
      ["version_unavailable", "version_unavailable", 503],
      ["validator_busy", "validator_busy", 503],
    ])("the validator's %s: unavailable, %s", async (fault, reason, status) => {
      fake.nextFault(fault);
      expect(await client.validate(CHECK)).toEqual({ kind: "unavailable", reason, status });
    });

    it("a secret the validator doesn't take (401): unavailable, unauthorized", async () => {
      const wrong = createOtelcolValidatorClient({ url: fake.url, secret: "not-the-fake-validator-secret-0123456789" });
      expect(await wrong.validate(CHECK)).toEqual({ kind: "unavailable", reason: "unauthorized", status: 401 });
    });

    it("an answer its schema refuses: unavailable, malformed_reply", async () => {
      fake.nextFault("malformed_reply");
      expect(await client.validate(CHECK)).toEqual({ kind: "unavailable", reason: "malformed_reply", status: 200 });
      // The fake saw its own reply break the contract.
      expect(fake.takeViolations()).toEqual([expect.stringContaining("reply 200 body")]);
    });

    it("no answer in time: unavailable, timeout", async () => {
      const slow = createOtelcolValidatorClient({ url: fake.url, secret: fake.secret, timeoutMs: 100 });
      fake.nextFault("hang");
      expect(await slow.validate(CHECK)).toEqual({ kind: "unavailable", reason: "timeout" });
    });

    it("a body that stops arriving: the one timer covers it too", async () => {
      const { doFetch } = answering(
        () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("{")) }), { status: 200 }),
      );
      // The stream never ends; only the timer's abort ends the read.
      const stalled: typeof fetch = (async (url: string, init: RequestInit) => {
        const response = await doFetch(url, init);
        const reader = response.body!.getReader();
        const body = new ReadableStream({
          async pull(controller) {
            const next = await Promise.race([
              reader.read(),
              new Promise<never>((_resolve, reject) =>
                init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
              ),
            ]);
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
        });
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch;
      const slow = createOtelcolValidatorClient({ url: "http://validator.invalid", secret: "s".repeat(32), fetch: stalled, timeoutMs: 100 });

      expect(await slow.validate(CHECK)).toEqual({ kind: "unavailable", reason: "timeout" });
    });

    it("a connection reset: unavailable, network", async () => {
      fake.nextFault("reset");
      expect(await client.validate(CHECK)).toEqual({ kind: "unavailable", reason: "network" });
    });

    it("nothing listening: unavailable, network", async () => {
      const down = createOtelcolValidatorClient({ url: await closedUrl(), secret: fake.secret });
      expect(await down.validate(CHECK)).toEqual({ kind: "unavailable", reason: "network" });
    });

    it.each([
      ["a redirect, never followed", 302, "unexpected_status"],
      ["a 2xx other than 200", 204, "unexpected_status"],
      ["a 502", 502, "server_error"],
      ["a 422", 422, "unexpected_status"],
    ] as const)("%s: unavailable, %s", async (_label, status, reason) => {
      const { seen, doFetch } = answering(
        () => new Response(status === 204 ? null : "{}", { status, headers: status === 302 ? { location: "http://elsewhere.invalid/" } : {} }),
      );
      const odd = createOtelcolValidatorClient({ url: "http://validator.invalid", secret: "s".repeat(32), fetch: doFetch });

      expect(await odd.validate(CHECK)).toEqual({ kind: "unavailable", reason, status });
      expect(seen).toHaveLength(1);
    });

    it.each([
      ["not JSON", "<html>oops</html>"],
      ["valid with errors", JSON.stringify({ valid: true, errors: [{ message: "x", componentPath: null }], requirements: [], distribution: CHECK.distribution, version: CHECK.version })],
      ["invalid without errors", JSON.stringify({ valid: false, errors: [], requirements: [], distribution: CHECK.distribution, version: CHECK.version })],
      ["a category it doesn't know", JSON.stringify({ valid: true, errors: [], requirements: [{ category: "org_variable", title: "t", description: "d", componentPath: null }], distribution: CHECK.distribution, version: CHECK.version })],
      ["another distribution's answer", JSON.stringify({ valid: true, errors: [], requirements: [], distribution: "otelcol-core", version: CHECK.version })],
      ["another version's answer", JSON.stringify({ valid: true, errors: [], requirements: [], distribution: CHECK.distribution, version: "0.161.0" })],
    ])("a 200 that is %s: unavailable, malformed_reply", async (_label, body) => {
      const { doFetch } = answering(() => new Response(body, { status: 200 }));
      const odd = createOtelcolValidatorClient({ url: "http://validator.invalid", secret: "s".repeat(32), fetch: doFetch });

      expect(await odd.validate(CHECK)).toEqual({ kind: "unavailable", reason: "malformed_reply", status: 200 });
    });

    describe("a reply is read up to a cap (Ruling 55)", () => {
      const VALID = JSON.stringify({ valid: true, errors: [], requirements: [], distribution: CHECK.distribution, version: CHECK.version });

      it("caps it at 4 MiB by default", () => {
        expect(MAX_OTELCOL_VALIDATOR_REPLY_BYTES).toBe(4 * 1024 * 1024);
      });

      it("reads a reply at the cap", async () => {
        const body = VALID.padEnd(1024, " ");
        const { doFetch } = answering(() => new Response(body, { status: 200 }));
        const capped = createOtelcolValidatorClient({ url: "http://validator.invalid", secret: "s".repeat(32), fetch: doFetch, maxReplyBytes: 1024 });

        expect(await capped.validate(CHECK)).toEqual({ kind: "checked", valid: true, errors: [], requirements: [] });
      });

      it("a streamed reply one byte over the cap: unavailable, oversized_reply, and the rest never read", async () => {
        const body = VALID.padEnd(1025, " ");
        const encoded = new TextEncoder().encode(body);
        let pulls = 0;
        let cancelled = false;
        // 100 chunks of the reply; only as many are read as reach past the cap.
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(encoded);
            else controller.enqueue(new Uint8Array(1024));
            if (pulls === 100) controller.close();
          },
          cancel() {
            cancelled = true;
          },
        });
        const { doFetch } = answering(() => new Response(stream, { status: 200 }));
        const capped = createOtelcolValidatorClient({ url: "http://validator.invalid", secret: "s".repeat(32), fetch: doFetch, maxReplyBytes: 1024 });

        expect(await capped.validate(CHECK)).toEqual({ kind: "unavailable", reason: "oversized_reply", status: 200 });
        expect(cancelled).toBe(true);
        expect(pulls).toBeLessThan(100);
      });

      it("a declared Content-Length over the cap: unavailable, oversized_reply, nothing read", async () => {
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new TextEncoder().encode(VALID));
            controller.close();
          },
        });
        const { doFetch } = answering(() => new Response(stream, { status: 200, headers: { "content-length": "1025" } }));
        const capped = createOtelcolValidatorClient({ url: "http://validator.invalid", secret: "s".repeat(32), fetch: doFetch, maxReplyBytes: 1024 });

        expect(await capped.validate(CHECK)).toEqual({ kind: "unavailable", reason: "oversized_reply", status: 200 });
        // The stream's first pull happens on construction at most; no reading followed.
        expect(pulls).toBeLessThanOrEqual(1);
      });

      it("a 503 over the cap: unavailable, oversized_reply", async () => {
        const body = JSON.stringify({ error: { code: "validator_busy", message: "busy" } }).padEnd(1025, " ");
        const { doFetch } = answering(() => new Response(body, { status: 503 }));
        const capped = createOtelcolValidatorClient({ url: "http://validator.invalid", secret: "s".repeat(32), fetch: doFetch, maxReplyBytes: 1024 });

        expect(await capped.validate(CHECK)).toEqual({ kind: "unavailable", reason: "oversized_reply", status: 503 });
      });
    });

    it("a 503 without the envelope: unavailable, server_error", async () => {
      const { doFetch } = answering(() => new Response("busy", { status: 503 }));
      const odd = createOtelcolValidatorClient({ url: "http://validator.invalid", secret: "s".repeat(32), fetch: doFetch });

      expect(await odd.validate(CHECK)).toEqual({ kind: "unavailable", reason: "server_error", status: 503 });
    });

    it("never puts the secret or the text in a result", async () => {
      const secret = "secret-that-must-never-appear-0123456789";
      const results = [
        await createOtelcolValidatorClient({ url: fake.url, secret }).validate({ ...CHECK, yaml: "marker-in-the-text: 1\n" }),
        await createOtelcolValidatorClient({ url: await closedUrl(), secret }).validate({ ...CHECK, yaml: "marker-in-the-text: 1\n" }),
      ];
      for (const result of results) {
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain("marker-in-the-text");
      }
    });
  });
});
