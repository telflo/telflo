import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryFile } from "@telflo/contracts";

/*
 * The browser client's library calls (D23-2 decisions 42 and 54; Preflight
 * ruling 19), against a fake API behind a custom axios adapter, as
 * api-client.testing.test.ts does: the members' list, bytes and link; the
 * product admin's create (multipart, the parts in the API's order), change
 * and delete; the refusals as their codes and words.
 *
 * The link here is a hand-written fixture, visibly fake (`tll_FAKE…`,
 * decision 59), so it may be compared directly: nothing here is signed.
 * Names, descriptions and file names carry the private-text marker "zq".
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
type Reply = { status: number; body?: unknown; bytes?: Uint8Array; envelopeAsBytes?: boolean };

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
      headers: new AxiosHeaders({ "content-type": reply.bytes ? "application/octet-stream" : "application/json" }),
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

const FILES = "/api/v1/library-files";
const FILE: LibraryFile = {
  id: "0199f400-0000-7000-8000-000000000001",
  name: "zq-getting-started",
  description: "zq-about",
  fileName: "zq-sample.json",
  sizeBytes: 2,
  createdAt: "2026-10-24T12:00:00.000Z",
  updatedAt: "2026-10-24T12:00:00.000Z",
};
/** A visibly fake link's path (decision 59): the contract's shape, never signed. */
const FAKE_LINK_PATH = `/api/v1/library-links/tll_${"FAKE".repeat(17)}FAK`;

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

describe("the members' library calls (D23-2 decision 54)", () => {
  it("lists the files with a GET (no CSRF header), parsed; a list that isn't the contract's is unexpected_response", async () => {
    api.routes[`GET ${FILES}`] = () => ({ status: 200, body: { libraryFiles: [FILE] } });

    await expect(client.getLibraryFiles()).resolves.toEqual({ libraryFiles: [FILE] });
    expect(api.requests[0]?.headers["x-telflo-csrf"]).toBeUndefined();

    api.routes[`GET ${FILES}`] = () => ({ status: 200, body: { libraryFiles: [{ ...FILE, sizeBytes: -1 }] } });
    await expect(client.getLibraryFiles()).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("an aborted list read answers request_aborted", async () => {
    const aborted = new AbortController();
    aborted.abort();

    await expect(client.getLibraryFiles({ signal: aborted.signal })).rejects.toMatchObject({ code: client.REQUEST_ABORTED });
  });

  it("reads a file's bytes whole as an arraybuffer, by its id alone, encoded", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    api.routes[`GET ${FILES}/${FILE.id}/file`] = () => ({ status: 200, bytes });
    api.routes[`GET ${FILES}/a%2F..%2Fb/file`] = () => ({ status: 200, bytes });

    await expect(client.getLibraryFileBytes(FILE.id)).resolves.toEqual(bytes);
    await expect(client.getLibraryFileBytes("a/../b")).resolves.toEqual(bytes);
    expect(api.requests.map((request) => request.responseType)).toEqual(["arraybuffer", "arraybuffer"]);
  });

  it("carries a bytes read's refusal, sent as bytes, as its code and words", async () => {
    api.routes[`GET ${FILES}/${FILE.id}/file`] = () => ({
      status: 404,
      body: envelope("library_file_not_found", "Library file not found"),
      envelopeAsBytes: true,
    });

    await expect(client.getLibraryFileBytes(FILE.id)).rejects.toMatchObject({
      code: "library_file_not_found",
      message: "Library file not found",
      status: 404,
    });
  });

  it("asks for a link with a POST carrying the CSRF header and no body, by the file's id alone; answers the path", async () => {
    api.routes[`POST ${FILES}/${FILE.id}/link`] = () => ({ status: 201, body: { path: FAKE_LINK_PATH } });

    await expect(client.createLibraryFileLink(FILE.id)).resolves.toEqual({ path: FAKE_LINK_PATH });

    const [request] = api.requests;
    expect(request?.headers["x-telflo-csrf"]).toBeDefined();
    expect(request?.body).toBeUndefined();
    expect(request?.url).toBe(`${FILES}/${FILE.id}/link`);
  });

  it("refuses a link reply that isn't the contract's path as unexpected_response", async () => {
    for (const path of ["https://elsewhere.example/api/v1/library-links/tll_x", `/api/v1/quick-deploy/tqd_${"FAKE".repeat(5)}`, ""]) {
      api.routes[`POST ${FILES}/${FILE.id}/link`] = () => ({ status: 201, body: { path } });
      await expect(client.createLibraryFileLink(FILE.id)).rejects.toMatchObject({ code: "unexpected_response" });
    }
  });

  it("carries the link's refusals as their codes and words", async () => {
    const refusals: [number, string, string][] = [
      [404, "library_file_not_found", "Library file not found"],
      [429, "rate_limited", "Too many requests. Try again shortly."],
      [403, "terms_acceptance_required", "Accept the current terms to continue."],
    ];
    for (const [status, code, message] of refusals) {
      api.routes[`POST ${FILES}/${FILE.id}/link`] = () => ({ status, body: envelope(code, message) });
      await expect(client.createLibraryFileLink(FILE.id)).rejects.toMatchObject({ code, message, status });
    }
  });
});

describe("the product admin's library writes (D23-2 decisions 42 to 44)", () => {
  it("uploads multipart: name, description, file, in that order, with the CSRF header and no content type set by hand; no name in the address", async () => {
    api.routes[`POST ${FILES}`] = () => ({ status: 201, body: { libraryFile: FILE } });
    const file = new File(["{}"], "zq-sample.json", { type: "application/json" });

    await expect(client.createLibraryFile({ name: "zq-getting-started", description: "zq-about", file })).resolves.toEqual({
      libraryFile: FILE,
    });

    const [request] = api.requests;
    expect(await partsOf(request?.body)).toEqual([
      ["name", "zq-getting-started"],
      ["description", "zq-about"],
      ["file", { name: "zq-sample.json", type: "application/json", text: "{}" }],
    ]);
    expect(request?.headers["x-telflo-csrf"]).toBeDefined();
    expect(request?.headers["content-type"] ?? "").not.toMatch(/multipart/i);
    expect(request?.url).toBe(FILES);
  });

  it("sends an empty description as '' (none)", async () => {
    api.routes[`POST ${FILES}`] = () => ({ status: 201, body: { libraryFile: FILE } });

    await client.createLibraryFile({ name: "zq-a", description: "", file: new File(["x"], "zq-a.bin") });

    expect((await partsOf(api.requests[0]?.body))[1]).toEqual(["description", ""]);
  });

  it("carries the API's refusals as their codes and words: 413, 400 and a non-admin's 403", async () => {
    const upload = { name: "a", description: "", file: new File(["x"], "a.bin") };
    const refusals: [number, string, string][] = [
      [413, "library_file_too_large", "The file must be 10 MB or smaller."],
      [400, "invalid_request", "The request is invalid."],
      [403, "product_admin_required", "Only product admins can do that."],
    ];
    for (const [status, code, message] of refusals) {
      api.routes[`POST ${FILES}`] = () => ({ status, body: envelope(code, message) });
      await expect(client.createLibraryFile(upload)).rejects.toMatchObject({ code, message, status });
    }
  });

  it("changes a file's name and description with a JSON PATCH and deletes it, each by its id alone, encoded, with the CSRF header", async () => {
    api.routes[`PATCH ${FILES}/${FILE.id}`] = () => ({ status: 200, body: { libraryFile: FILE } });
    api.routes[`DELETE ${FILES}/a%2F..%2Fb`] = () => ({ status: 204 });

    await expect(client.updateLibraryFile(FILE.id, { name: "zq-renamed", description: "" })).resolves.toEqual({ libraryFile: FILE });
    await expect(client.deleteLibraryFile("a/../b")).resolves.toBeUndefined();

    expect(api.requests.map((seen) => [seen.method, seen.body])).toEqual([
      ["PATCH", { name: "zq-renamed", description: "" }],
      ["DELETE", undefined],
    ]);
    for (const request of api.requests) {
      expect(request.headers["x-telflo-csrf"]).toBeDefined();
      expect(request.url).not.toContain("zq");
    }
  });

  it("carries a change's and a delete's 404 and 403 as their codes", async () => {
    api.routes[`PATCH ${FILES}/${FILE.id}`] = () => ({ status: 404, body: envelope("library_file_not_found", "Library file not found") });
    api.routes[`DELETE ${FILES}/${FILE.id}`] = () => ({ status: 403, body: envelope("product_admin_required", "Only product admins can do that.") });

    await expect(client.updateLibraryFile(FILE.id, { name: "a" })).rejects.toMatchObject({ code: "library_file_not_found", status: 404 });
    await expect(client.deleteLibraryFile(FILE.id)).rejects.toMatchObject({ code: "product_admin_required", status: 403 });
  });
});
