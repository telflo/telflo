import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envelope, fakeFetch, routedFetch } from "../tests/fake-fetch.js";
import {
  ApiClient,
  ApiError,
  BAD_GATEWAY_MESSAGE,
  DEFAULT_TIMEOUT_MS,
  GATEWAY_TIMEOUT_MESSAGE,
  LONG_TIMEOUT_MS,
  MAXIMUM_PAGES,
  MAXIMUM_REPLY_BYTES,
  MAXIMUM_TEXT_REPLY_BYTES,
  pipelineSegment,
  RATE_LIMIT_WAIT_LINE,
  RATE_LIMITED_MESSAGE,
  REDIRECT_MESSAGE,
  REPEATED_CURSOR_MESSAGE,
  REPLY_TOO_LARGE_MESSAGE,
  retryAfterSecondsOf,
  segment,
  TIMEOUT_MESSAGE,
  TOO_LARGE_MESSAGE,
  TOO_MANY_PAGES_MESSAGE,
  UNEXPECTED_REPLY_MESSAGE,
  UNREACHABLE_MESSAGE,
  userAgent,
} from "./api.js";
import { ExitError, setIo, setJsonMode } from "./output.js";
import { VERSION } from "./version.js";

/*
 * The client (D27 decisions 16-18), against a stand-in fetch. The token is
 * made at run time and checked with boolean canaries only.
 */

const SERVER = "https://telflo.example";
const TOKEN = `tf_${randomBytes(32).toString("base64url")}`;
const ORGANIZATION = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";

let stderr: string[];

beforeEach(() => {
  stderr = [];
  setIo({ stderr: (text) => void stderr.push(text), stdout: () => undefined });
});

afterEach(() => {
  setIo();
  vi.useRealTimers();
});

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the request didn't fail");
}

describe("the client's requests (decision 16)", () => {
  it("calls the public prefix with the token, Accept, User-Agent and no redirect followed", async () => {
    const fake = fakeFetch(() => ({ json: { ok: true } }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    expect(await client.request("GET", "/configurations", { query: { limit: 5, cursor: undefined, flag: true } })).toEqual({ ok: true });
    const [call] = fake.calls;
    expect(call?.url.origin).toBe(SERVER);
    expect(call?.url.pathname).toBe("/api/public/v1/configurations");
    expect(call?.url.search).toBe("?limit=5&flag=true");
    expect(call?.headers.get("authorization") === `Bearer ${TOKEN}`).toBe(true);
    expect(call?.headers.get("accept")).toBe("application/json");
    expect(call?.headers.get("user-agent")).toBe(`telflo-cli/${VERSION} node/${process.versions.node} ${process.platform}`);
    expect(call?.headers.get("content-type")).toBeNull();
    expect(call?.headers.get("x-telflo-org")).toBeNull();
    expect(call?.redirect).toBe("manual");
    expect(userAgent().startsWith("telflo-cli/")).toBe(true);
  });

  it("sends a body as JSON with its Content-Type, and X-Telflo-Org unless the route takes none", async () => {
    const fake = fakeFetch(() => ({ status: 201, json: { id: "x" } }));
    const organizationId = vi.fn(async () => ORGANIZATION);
    const client = new ApiClient({ server: SERVER, token: TOKEN, organizationId, fetch: fake.fetch });
    await client.request("POST", "/configurations", { body: { name: "a", yaml: "b" } });
    await client.request("GET", "/whoami", { organization: false });
    expect(fake.calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(fake.calls[0]?.body).toBe(JSON.stringify({ name: "a", yaml: "b" }));
    expect(fake.calls[0]?.headers.get("x-telflo-org")).toBe(ORGANIZATION);
    expect(fake.calls[1]?.headers.get("x-telflo-org")).toBeNull();
    expect(organizationId).toHaveBeenCalledTimes(1);
  });

  it("leaves X-Telflo-Org out when the organization is unknown (a service account's token)", async () => {
    const fake = fakeFetch(() => ({ json: {} }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, organizationId: async () => undefined, fetch: fake.fetch });
    await client.request("GET", "/fleets");
    expect(fake.calls[0]?.headers.get("x-telflo-org")).toBeNull();
  });

  it("sends no Authorization without a token (the open routes)", async () => {
    const fake = fakeFetch(() => ({ json: { valid: true } }));
    const client = new ApiClient({ server: "http://127.0.0.1:8080", fetch: fake.fetch });
    expect(client.authenticated).toBe(false);
    await client.request("POST", "/validate/anonymous", { body: { yaml: "a" }, organization: false });
    expect(fake.calls[0]?.headers.has("authorization")).toBe(false);
    expect(fake.calls[0]?.url.origin).toBe("http://127.0.0.1:8080");
  });

  it("answers text as is, and nothing for an empty or 204 reply", async () => {
    const fake = fakeFetch((_call, index) =>
      index === 0 ? { text: "raw output" } : index === 1 ? { status: 204 } : { status: 200, json: undefined, text: "" },
    );
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    expect(await client.request("GET", "/test-runs/r/output", { text: true })).toBe("raw output");
    expect(fake.calls[0]?.headers.get("accept")).toBe("text/plain, application/json");
    expect(await client.request("DELETE", "/x")).toBeUndefined();
    expect(await client.request("GET", "/y")).toBeUndefined();
  });

  it("refuses a 2xx that isn't JSON where JSON was asked for", async () => {
    const fake = fakeFetch(() => ({ text: "<html>a portal</html>", headers: { "content-type": "text/html" } }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    const error = await refusal(client.request("GET", "/fleets"));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe(UNEXPECTED_REPLY_MESSAGE(200));
  });

  it("parses a JSON reply that starts with a BOM, dropping one (Ruling 242)", async () => {
    const fake = fakeFetch((_call, index) =>
      new Response(index === 0 ? '\uFEFF{"ok":true}' : '\uFEFF\uFEFF{"ok":true}', { headers: { "content-type": "application/json" } }),
    );
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    expect(await client.request("GET", "/a")).toEqual({ ok: true });
    expect(((await refusal(client.request("GET", "/a"))) as ApiError).message).toBe(UNEXPECTED_REPLY_MESSAGE(200));
  });

  it("keeps a text reply's BOM (text: true is the text whole)", async () => {
    const fake = fakeFetch(() => new Response("\uFEFFline\n", { headers: { "content-type": "text/plain" } }));
    const text = await new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch }).request<string>("GET", "/o", { text: true });
    expect(text === "\uFEFFline\n").toBe(true);
  });

  it("refuses a 2xx whose JSON doesn't parse", async () => {
    const fake = fakeFetch(() => ({ text: "{not json", headers: { "content-type": "application/json" } }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    expect(((await refusal(client.request("GET", "/fleets"))) as ApiError).message).toBe(UNEXPECTED_REPLY_MESSAGE(200));
  });

  it("is made only for an origin the HTTPS rule accepts (decision 12)", () => {
    for (const server of ["http://telflo.example", "https://telflo.example/api", "https://telflo.example/", "telflo.example"]) {
      expect(() => new ApiClient({ server, token: TOKEN })).toThrow(ExitError);
    }
    expect(new ApiClient({ server: "http://localhost:3000", token: TOKEN }).server).toBe("http://localhost:3000");
  });

  it("uses the global fetch by default", async () => {
    const fake = fakeFetch(() => ({ json: { ok: 1 } }));
    vi.stubGlobal("fetch", fake.fetch);
    try {
      expect(await new ApiClient({ server: SERVER, token: TOKEN }).request("GET", "/whoami")).toEqual({ ok: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("path segments (decision 16)", () => {
  it("percent-encodes a segment and refuses . and ..", () => {
    expect(segment("a b/c?d#e")).toBe("a%20b%2Fc%3Fd%23e");
    expect(() => segment(".")).toThrow(ExitError);
    expect(() => segment("..")).toThrow(ExitError);
    expect(segment("...")).toBe("...");
  });

  it("keeps a pipeline name's / and encodes the rest; a . or .. part is refused", () => {
    expect(pipelineSegment("logs/in")).toBe("logs/in");
    expect(pipelineSegment("logs/a b")).toBe("logs/a%20b");
    expect(() => pipelineSegment("logs/../x")).toThrow(ExitError);
    expect(() => pipelineSegment("./x")).toThrow(ExitError);
  });
});

describe("errors in fixed words (decision 18)", () => {
  it("shows the envelope's message and keeps its code and details", async () => {
    const details = { errors: [{ message: "m" }] };
    const fake = fakeFetch(() => ({ status: 422, json: envelope("configuration_invalid", "The YAML isn't valid.", details) }));
    const error = (await refusal(new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch }).request("PATCH", "/x"))) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(422);
    expect(error.code).toBe("configuration_invalid");
    expect(error.message).toBe("The YAML isn't valid.");
    expect(error.details).toEqual(details);
  });

  it("flattens control characters out of an envelope's message and cuts a long one", async () => {
    const fake = fakeFetch((_call, index) => ({
      status: 400,
      json: envelope("x", index === 0 ? "a\u001b[31mred\u0007\nline" : "y".repeat(600)),
    }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    expect(((await refusal(client.request("GET", "/a"))) as ApiError).message).toBe("a [31mred line");
    expect(((await refusal(client.request("GET", "/a"))) as ApiError).message).toBe(`${"y".repeat(500)}…`);
  });

  it.each([
    [413, TOO_LARGE_MESSAGE],
    [502, BAD_GATEWAY_MESSAGE],
    [504, GATEWAY_TIMEOUT_MESSAGE],
    [500, UNEXPECTED_REPLY_MESSAGE(500)],
    [404, UNEXPECTED_REPLY_MESSAGE(404)],
  ])("answers the gateway's HTML %i with fixed words, never the body", async (status, words) => {
    const fake = fakeFetch(() => ({ status, text: "<html><body>nginx secret-page</body></html>", headers: { "content-type": "text/html" } }));
    const error = (await refusal(new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch }).request("GET", "/a"))) as ApiError;
    expect(error.message).toBe(words);
    expect(error.code).toBeNull();
    expect(error.message.includes("nginx")).toBe(false);
  });

  it("redacts a token an envelope's message quotes (Ruling 237)", async () => {
    const fake = fakeFetch(() => ({ status: 400, json: envelope("bad", `Refused: Bearer ${TOKEN}`) }));
    const error = (await refusal(new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch }).request("GET", "/a"))) as ApiError;
    expect(error.message.includes(TOKEN)).toBe(false);
    expect(error.message === "Refused: Bearer tf_…").toBe(true);
  });

  it("reads a JSON reply that isn't the envelope by its status", async () => {
    const fake = fakeFetch(() => ({ status: 500, json: { detail: "another shape" } }));
    const error = (await refusal(new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch }).request("GET", "/a"))) as ApiError;
    expect(error.message).toBe(UNEXPECTED_REPLY_MESSAGE(500));
  });

  it("follows no redirect: a 302 to another origin is an error, and no second request is made", async () => {
    const fake = fakeFetch(() => ({ status: 302, text: "", headers: { location: "https://elsewhere.example/steal" } }));
    const error = (await refusal(new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch }).request("GET", "/whoami"))) as ApiError;
    expect(error.message).toBe(REDIRECT_MESSAGE(302));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls.some((call) => call.url.origin !== SERVER)).toBe(false);
  });

  it("says only the origin when the server can't be reached", async () => {
    const fetch = (async () => {
      throw new TypeError(`fetch failed for https://telflo.example/api/public/v1/x?token=${TOKEN}`);
    }) as typeof globalThis.fetch;
    const error = (await refusal(new ApiClient({ server: SERVER, token: TOKEN, fetch }).request("GET", "/x"))) as ExitError;
    expect(error).toBeInstanceOf(ExitError);
    expect(error.message.includes(TOKEN)).toBe(false);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe(UNREACHABLE_MESSAGE(SERVER));
  });

  it("times out after 30 s by default, and after the caller's limit", async () => {
    vi.useFakeTimers();
    const hanging = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: hanging.fetch });
    const defaultRefusal = refusal(client.request("GET", "/x"));
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    expect(hanging.calls[0]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const first = (await defaultRefusal) as ExitError;
    expect(first.message).toBe(TIMEOUT_MESSAGE(DEFAULT_TIMEOUT_MS));
    expect(first.exitCode).toBe(1);

    const longRefusal = refusal(client.request("POST", "/test-runs", { timeoutMs: LONG_TIMEOUT_MS }));
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(hanging.calls[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(LONG_TIMEOUT_MS - DEFAULT_TIMEOUT_MS);
    expect(((await longRefusal) as ExitError).message).toBe(TIMEOUT_MESSAGE(LONG_TIMEOUT_MS));
  });
});

describe("429 and Retry-After (decision 17, Preflight ruling 10)", () => {
  function limited(retryAfter: string | undefined) {
    return {
      status: 429,
      json: envelope("rate_limited", "Too many attempts. Please wait and try again."),
      ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }),
    };
  }

  it("retries after Retry-After, with one stderr line per wait, then answers", async () => {
    const waits: number[] = [];
    const fake = fakeFetch((_call, index) => (index < 2 ? limited(index === 0 ? "7" : "2") : { status: 201, json: { id: "made" } }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch, sleep: async (ms) => void waits.push(ms) });
    expect(await client.request("POST", "/fleets", { body: { label: "a" } })).toEqual({ id: "made" });
    expect(waits).toEqual([7000, 2000]);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.every((call) => call.body === JSON.stringify({ label: "a" }))).toBe(true);
    expect(stderr).toEqual([`${RATE_LIMIT_WAIT_LINE(7)}\n`, `${RATE_LIMIT_WAIT_LINE(2)}\n`]);
  });

  it("with --json, each wait is one JSON note on stderr (Ruling 249)", async () => {
    setJsonMode(true);
    try {
      const fake = fakeFetch((_call, index) => (index < 1 ? limited("4") : { json: { ok: true } }));
      const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch, sleep: async () => undefined });
      expect(await client.request("GET", "/fleets")).toEqual({ ok: true });
      expect(stderr).toEqual([`${JSON.stringify({ note: RATE_LIMIT_WAIT_LINE(4) })}\n`]);
    } finally {
      setJsonMode(false);
    }
  });

  it("retries at most 3 times, then exits 1 with the wait", async () => {
    const waits: number[] = [];
    const fake = fakeFetch(() => limited("9"));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch, sleep: async (ms) => void waits.push(ms) });
    const error = (await refusal(client.request("GET", "/fleets"))) as ApiError;
    expect(fake.calls).toHaveLength(4);
    expect(waits).toEqual([9000, 9000, 9000]);
    expect(error.status).toBe(429);
    expect(error.code).toBe("rate_limited");
    expect(error.message).toBe(RATE_LIMITED_MESSAGE(9));
  });

  it("caps each wait at 60 s and counts a bad value as 5", async () => {
    const waits: number[] = [];
    const fake = fakeFetch((_call, index) => (index === 0 ? limited("3600") : index === 1 ? limited("soon") : { json: {} }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch, sleep: async (ms) => void waits.push(ms) });
    await client.request("GET", "/fleets");
    expect(waits).toEqual([60_000, 5000]);
  });

  it("doesn't retry a 429 without Retry-After (test_run_queue_full): its own words", async () => {
    const sleep = vi.fn(async () => undefined);
    const fake = fakeFetch(() => ({ status: 429, json: envelope("test_run_queue_full", "The test queue is full. Try again shortly.") }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch, sleep });
    const error = (await refusal(client.request("POST", "/test-runs"))) as ApiError;
    expect(fake.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error.code).toBe("test_run_queue_full");
    expect(error.message).toBe("The test queue is full. Try again shortly.");
  });

  it("waits with real timers by default", async () => {
    vi.useFakeTimers();
    const fake = fakeFetch((_call, index) => (index === 0 ? limited("1") : { json: { ok: true } }));
    const answered = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch }).request("GET", "/fleets");
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answered).toEqual({ ok: true });
  });

  it("reads Retry-After as whole seconds", () => {
    expect(retryAfterSecondsOf(null)).toBeNull();
    expect(retryAfterSecondsOf("0")).toBe(0);
    expect(retryAfterSecondsOf(" 12 ")).toBe(12);
    expect(retryAfterSecondsOf("1.5")).toBe(5);
    expect(retryAfterSecondsOf("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(5);
    expect(retryAfterSecondsOf("-3")).toBe(5);
  });
});

describe("paged lists (decision 16)", () => {
  it("follows nextCursor with limit=100", async () => {
    const fake = routedFetch({
      "GET /fleets": (call) => {
        const cursor = call.url.searchParams.get("cursor");
        if (cursor === null) return { json: { items: [1, 2], nextCursor: "c1" } };
        if (cursor === "c1") return { json: { items: [3], nextCursor: "c2" } };
        return { json: { items: [4], nextCursor: null } };
      },
    });
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    expect(await client.listAll<number>("/fleets")).toEqual([1, 2, 3, 4]);
    expect(fake.calls.map((call) => call.url.searchParams.get("limit"))).toEqual(["100", "100", "100"]);
    expect(fake.calls.map((call) => call.url.searchParams.get("cursor"))).toEqual([null, "c1", "c2"]);
  });

  it("stops after 100 pages", async () => {
    const fake = fakeFetch((_call, index) => ({ json: { items: [0], nextCursor: `c${index}` } }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    const error = (await refusal(client.listAll("/configurations"))) as ExitError;
    expect(error.message).toBe(TOO_MANY_PAGES_MESSAGE);
    expect(fake.calls).toHaveLength(MAXIMUM_PAGES);
  });

  it("stops on a repeated nextCursor (exit 1)", async () => {
    const fake = fakeFetch((_call, index) => ({ json: { items: [index], nextCursor: index === 0 ? "a" : "b" } }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    const error = (await refusal(client.listAll("/fleets"))) as ExitError;
    expect(error).toBeInstanceOf(ExitError);
    expect(error.message).toBe(REPEATED_CURSOR_MESSAGE);
    expect(error.exitCode).toBe(1);
    expect(fake.calls).toHaveLength(3);
  });

  it("refuses a page that isn't one", async () => {
    const fake = fakeFetch((_call, index) => (index === 0 ? { json: { nope: true } } : { status: 204 }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    expect(((await refusal(client.listAll("/fleets"))) as ApiError).message).toBe(UNEXPECTED_REPLY_MESSAGE(200));
    expect(((await refusal(client.listAll("/fleets"))) as ApiError).message).toBe(UNEXPECTED_REPLY_MESSAGE(200));
  });
});

describe("the reply's size (Ruling 237)", () => {
  it("refuses a JSON reply over 16 MiB, streamed or declared (exit 1)", async () => {
    const big = `"${"a".repeat(MAXIMUM_REPLY_BYTES)}"`;
    const streamed = fakeFetch(() => new Response(big, { headers: { "content-type": "application/json" } }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: streamed.fetch });
    const error = (await refusal(client.request("GET", "/a"))) as ExitError;
    expect(error).toBeInstanceOf(ExitError);
    expect(error.message).toBe(REPLY_TOO_LARGE_MESSAGE);
    expect(error.exitCode).toBe(1);

    const declared = fakeFetch(
      () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(MAXIMUM_REPLY_BYTES + 1) } }),
    );
    const refused = (await refusal(new ApiClient({ server: SERVER, token: TOKEN, fetch: declared.fetch }).request("GET", "/a"))) as ExitError;
    expect(refused.message).toBe(REPLY_TOO_LARGE_MESSAGE);
  });

  it("reads a text reply up to 32 MiB, and refuses one over it", async () => {
    const twenty = "b".repeat(20 * 1024 * 1024);
    const fake = fakeFetch((_call, index) => ({ text: index === 0 ? twenty : "c".repeat(MAXIMUM_TEXT_REPLY_BYTES + 1) }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    expect(((await client.request("GET", "/test-runs/r/output", { text: true })) as string).length).toBe(twenty.length);
    expect(((await refusal(client.request("GET", "/test-runs/r/output", { text: true }))) as ExitError).message).toBe(REPLY_TOO_LARGE_MESSAGE);
  });

  it("answers the reply's bytes exactly with bytes: true, a BOM and an invalid byte kept (Ruling 238)", async () => {
    const sent = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62, 0x0a]);
    const fake = fakeFetch(() => new Response(sent, { headers: { "content-type": "text/plain; charset=utf-8" } }));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    const bytes = await client.request<Buffer>("GET", "/test-runs/r/output", { bytes: true });
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.equals(sent)).toBe(true);
    expect(fake.calls[0]?.headers.get("accept")).toBe("text/plain, application/json");
    const empty = fakeFetch(() => new Response(null, { status: 200 }));
    expect((await new ApiClient({ server: SERVER, token: TOKEN, fetch: empty.fetch }).request<Buffer>("GET", "/x", { bytes: true })).length).toBe(0);
  });

  it("caps bytes: true at 32 MiB", async () => {
    const fake = fakeFetch(() => new Response(Buffer.alloc(MAXIMUM_TEXT_REPLY_BYTES + 1)));
    const client = new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch });
    expect(((await refusal(client.request("GET", "/test-runs/r/output", { bytes: true }))) as ExitError).message).toBe(REPLY_TOO_LARGE_MESSAGE);
  });

  it("answers an empty body for a reply with none", async () => {
    const fake = fakeFetch(() => new Response(null, { status: 200, headers: { "content-type": "application/json" } }));
    expect(await new ApiClient({ server: SERVER, token: TOKEN, fetch: fake.fetch }).request("GET", "/a")).toBeUndefined();
  });
});
