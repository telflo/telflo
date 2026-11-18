import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FAKE_OTELCOL_VALIDATOR_UNAVAILABLE_MARKER,
  startFakeOtelcolValidator,
  type FakeOtelcolValidator,
  type FakeOtelcolValidatorFault,
} from "./fake-otelcol-validator.js";

// The fake collector validator's own contract checks (D13b Preflight ruling
// 20): it must catch a request that breaks services/otelcol-validator/openapi.yaml,
// and a reply of its own that does, or the client's and the API's tests
// against it prove nothing; and it must answer by the text, as the browser
// tests rely on. These tests send raw requests, shaped as the client's are,
// then broken.

let fake: FakeOtelcolValidator;

beforeAll(async () => {
  fake = await startFakeOtelcolValidator();
});

afterEach(() => {
  expect(fake.takeViolations()).toEqual([]);
  fake.takeRequests();
});

afterAll(async () => {
  await fake.close();
});

const validateUrl = (distribution = "otelcol-contrib", version = "0.162.0") =>
  `${fake.url}/validator/v1/validate/${distribution}/${version}`;

function post(
  body: unknown,
  headers: Record<string, string> = {},
  url = validateUrl(),
  raw?: string,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

describe("the fake otelcol-validator's request validation", () => {
  it("accepts a request that keeps the contract, with no violation, and records what it read", async () => {
    const response = await post({ yaml: "receivers:\n  otlp: {}\n" });

    expect(response.status).toBe(200);
    expect(fake.takeViolations()).toEqual([]);
    expect(fake.takeRequests()).toEqual([
      { distribution: "otelcol-contrib", version: "0.162.0", yaml: "receivers:\n  otlp: {}\n" },
    ]);
  });

  it("catches a body missing yaml, a field the API doesn't know, and an empty yaml, answering 400", async () => {
    for (const body of [{}, { yaml: "a: 1\n", distribution: "otelcol-contrib" }, { yaml: "" }, { yaml: 3 }]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(fake.takeViolations()).toEqual([expect.stringContaining("validateConfiguration request body")]);
    }
  });

  it("accepts the organization's values within the server's bounds (150 of at most 1,024 characters, Q104), and records them (D20)", async () => {
    const organizationVariables = {
      HOST: "a$b",
      [`A${"_".repeat(127)}`]: "é".repeat(1024),
      EMPTY: "",
      ...Object.fromEntries(Array.from({ length: 147 }, (_, index) => [`V${index}`, "\u{1F680}".repeat(1024)])),
    };
    expect(Object.keys(organizationVariables)).toHaveLength(150);

    const response = await post({ yaml: "receivers:\n  otlp: {}\n", organizationVariables });

    expect(response.status).toBe(200);
    expect(fake.takeRequests()).toEqual([
      { distribution: "otelcol-contrib", version: "0.162.0", yaml: "receivers:\n  otlp: {}\n", organizationVariables },
    ]);
  });

  it("catches values outside the server's bounds, answering 400", async () => {
    for (const organizationVariables of [
      Object.fromEntries(Array.from({ length: 151 }, (_, index) => [`V${index}`, "v"])),
      { [`A${"_".repeat(128)}`]: "v" },
      { "9A": "v" },
      { A: "x".repeat(1025) },
      { A: "\u{1F680}".repeat(1025) },
      { A: "line\nbreak" },
      { A: "c1\u0085" },
      { A: "ls\u2028" },
      { A: 1 },
      [],
    ]) {
      const response = await post({ yaml: "a: 1\n", organizationVariables });
      expect(response.status).toBe(400);
      expect(fake.takeViolations()).toEqual([expect.stringContaining("validateConfiguration request body")]);
    }
  });

  it("catches a body over 2 MiB, answering 413 as the real validator does", async () => {
    const raw = `{"yaml": "a: 1\\n"${" ".repeat(2 * 1024 * 1024)}}`;

    const response = await post(undefined, {}, validateUrl(), raw);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large", message: "The request body is larger than 2 MiB." } });
    expect(fake.takeViolations()).toEqual([expect.stringContaining("larger than 2 MiB")]);
  });

  it("takes a body of 2 MiB exactly", async () => {
    const head = '{"yaml": "a: 1\\n"';
    const raw = `${head}${" ".repeat(2 * 1024 * 1024 - head.length - 1)}}`;

    const response = await post(undefined, {}, validateUrl(), raw);

    expect(response.status).toBe(200);
  });

  it("catches a yaml over 262,144 characters, answering 413 as the real validator does", async () => {
    const response = await post({ yaml: "#".repeat(262_145) });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
    expect(fake.takeViolations()).toEqual([expect.stringContaining("more than 262144 characters")]);
  });

  it("catches a distribution or a version that isn't in the path's format, answering 400", async () => {
    for (const url of [validateUrl("OpenTelemetry", "0.162.0"), validateUrl("otelcol-contrib", "latest")]) {
      const response = await post({ yaml: "a: 1\n" }, {}, url);
      expect(response.status).toBe(400);
      expect(fake.takeViolations()).toEqual([expect.stringContaining("path parameter")]);
    }
  });

  it("catches a body that isn't JSON, and the wrong Content-Type", async () => {
    expect((await post(undefined, {}, validateUrl(), "{not json")).status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("isn't JSON")]);

    expect((await post({ yaml: "a: 1\n" }, { "content-type": "text/plain" })).status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("Content-Type")]);
  });

  it("catches the secret sent without the Bearer scheme, and answers 401 with WWW-Authenticate", async () => {
    const response = await post({ yaml: "a: 1\n" }, { authorization: fake.secret });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(fake.takeViolations()).toEqual([expect.stringContaining("no Authorization: Bearer header")]);
    expect(fake.takeRequests()).toEqual([]);
  });

  it("answers a wrong secret 401 without a violation: that is a documented answer", async () => {
    const response = await post({ yaml: "a: 1\n" }, { authorization: "Bearer not-the-fake-secret-not-the-fake-secret" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid credentials." } });
    expect(fake.takeViolations()).toEqual([]);
  });

  it("catches a route the file doesn't document: a method, a path, a query", async () => {
    const get = await fetch(validateUrl(), { headers: { authorization: `Bearer ${fake.secret}` } });
    expect(get.status).toBe(404);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("the route isn't documented")]);

    const other = await post({ yaml: "a: 1\n" }, {}, `${fake.url}/validator/v1/validate/otelcol-contrib`);
    expect(other.status).toBe(404);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("the route isn't documented")]);

    expect((await post({ yaml: "a: 1\n" }, {}, `${validateUrl()}?debug=1`)).status).toBe(200);
    expect(fake.takeViolations()).toEqual([expect.stringContaining("has a query")]);
  });

  it("answers /health without the secret, as documented", async () => {
    const response = await fetch(`${fake.url}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("the fake otelcol-validator's answers by the text (Preflight ruling 20)", () => {
  it("answers valid by default, naming the collector it was asked for", async () => {
    const response = await post({ yaml: "receivers:\n  otlp: {}\n" }, {}, validateUrl("fixture-build", "1.2.3"));

    expect(await response.json()).toEqual({
      valid: true,
      errors: [],
      requirements: [],
      distribution: "fixture-build",
      version: "1.2.3",
    });
  });

  it("refuses each component whose type starts with unknown_, keeping the whole id in its path", async () => {
    const yaml = [
      "receivers:",
      "  otlp: {}",
      "  unknown_source/edge-1.v2: {}",
      "exporters:",
      "  unknown_sink: {}",
      "  debug: {}",
      "",
    ].join("\n");

    const body = (await (await post({ yaml })).json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      valid: false,
      errors: [
        { message: 'unknown type: "unknown_source" for id: "unknown_source/edge-1.v2"', componentPath: "receivers::unknown_source/edge-1.v2" },
        { message: 'unknown type: "unknown_sink" for id: "unknown_sink"', componentPath: "exporters::unknown_sink" },
      ],
    });
  });

  it("answers one env_var requirement per variable, valid or not", async () => {
    const yaml = 'exporters:\n  unknown_x:\n    endpoint: "${env:EXPORT_URL}"\n    key: ${env:API_KEY:-none}\n    again: ${env:EXPORT_URL}\n';

    const body = (await (await post({ yaml })).json()) as { valid: boolean; requirements: Array<Record<string, unknown>> };

    expect(body.valid).toBe(false);
    expect(body.requirements).toEqual([
      expect.objectContaining({ category: "env_var", title: "Set environment variable EXPORT_URL", componentPath: null }),
      expect.objectContaining({ category: "env_var", title: "Set environment variable API_KEY", componentPath: null }),
    ]);
  });

  it("answers one row naming the organization's values it was sent, as the validator names those it filled in (D20)", async () => {
    const body = (await (
      await post({ yaml: 'exporters:\n  debug:\n    x: "${env:LEVEL}"\n', organizationVariables: { B: "1", A: "2" } })
    ).json()) as { requirements: Array<Record<string, unknown>> };

    expect(body.requirements).toEqual([
      {
        category: "organization_variable",
        title: "Organization variables filled in",
        description: "Validation filled in your organization's values of these variables before its checks: B, A.",
        componentPath: null,
      },
      expect.objectContaining({ category: "env_var", title: "Set environment variable LEVEL" }),
    ]);
  });

  it("answers text that isn't YAML invalid, with a path naming nothing", async () => {
    const body = (await (await post({ yaml: "receivers: [\n" })).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ valid: false, errors: [{ componentPath: null }] });
  });

  it("answers 503 validator_busy for a text holding the unavailable marker", async () => {
    const response = await post({ yaml: `receivers: {}\n${FAKE_OTELCOL_VALIDATOR_UNAVAILABLE_MARKER}\n` });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "validator_busy" } });
  });
});

describe("the fake otelcol-validator's faults", () => {
  it.each<[FakeOtelcolValidatorFault, number, string]>([
    ["error_500", 500, "internal_error"],
    ["not_found", 404, "not_found"],
    ["version_retired", 409, "version_retired"],
    ["version_unavailable", 503, "version_unavailable"],
    ["validator_busy", 503, "validator_busy"],
    ["invalid_request", 400, "invalid_request"],
    ["payload_too_large", 413, "payload_too_large"],
  ])("answers %s once, as documented, with no violation", async (fault, status, code) => {
    fake.nextFault(fault);
    const response = await post({ yaml: "a: 1\n" });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });

    expect((await post({ yaml: "a: 1\n" })).status).toBe(200);
  });

  it("catches its own malformed reply as a violation", async () => {
    fake.nextFault("malformed_reply");
    const response = await post({ yaml: "a: 1\n" });

    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("valid");
    expect(fake.takeViolations()).toEqual([expect.stringContaining("validateConfiguration reply 200 body")]);
  });

  it("resets the connection", async () => {
    fake.nextFault("reset");
    await expect(post({ yaml: "a: 1\n" })).rejects.toThrow();
  });
});

describe("the fake otelcol-validator's close", () => {
  it("rejects while a violation is unread, so a test that forgets to look still fails", async () => {
    const own = await startFakeOtelcolValidator();
    await fetch(`${own.url}/validator/v1/validate/otelcol-contrib/0.162.0`, { method: "POST", body: "{}" });

    await expect(own.close()).rejects.toThrow(/contract violations no test read/);
  });

  it("ends a request it holds (hang) when it closes", async () => {
    const own = await startFakeOtelcolValidator();
    own.nextFault("hang");
    const pending = fetch(`${own.url}/validator/v1/validate/otelcol-contrib/0.162.0`, {
      method: "POST",
      headers: { authorization: `Bearer ${own.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ yaml: "a: 1\n" }),
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

describe("the fake otelcol-validator's options", () => {
  it("listens on the port it is given, as the browser tests' does (28086)", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const own = await startFakeOtelcolValidator({ port });
    expect(own.url).toBe(`http://127.0.0.1:${port}`);
    await own.close();
  });

  it("refuses to start on a port that is taken, rather than hanging", async () => {
    const port = Number(new URL(fake.url).port);
    await expect(startFakeOtelcolValidator({ port })).rejects.toThrow(/EADDRINUSE/);
  });

  it("tells onViolation each violation as it records it, and still keeps it for takeViolations", async () => {
    const told: string[] = [];
    const own = await startFakeOtelcolValidator({ onViolation: (message) => told.push(message) });
    await fetch(`${own.url}/validator/v1/validate/otelcol-contrib/0.162.0`, { method: "POST", body: "{}" });

    expect(told).toEqual([expect.stringContaining("no Authorization: Bearer header")]);
    expect(own.takeViolations()).toEqual(told);
    await own.close();
  });
});
