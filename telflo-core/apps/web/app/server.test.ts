// @vitest-environment node
// The web app's own server, ../server.mjs (D33-1 decisions 13 and 27,
// Preflight ruling 14). It lives in app/ because the web project's tests are
// found there. createApp is driven with a stub request handler and
// temporary folders: the same files and headers react-router-serve served,
// and no line on stdout or stderr per request (a unique marker in each URL
// is searched for: boolean canaries).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, installWarnFilter } from "../server.mjs";

const marker = `url-canary-${crypto.randomUUID()}`;
const script = `export const text = ${JSON.stringify("telflo ".repeat(400))};\n`;

let root: string;
let server: http.Server;
let port: number;
let handled: string[];
let written: string[];
let fail: Error | undefined;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "telflo-web-server-"));
  const clientDir = path.join(root, "client");
  const publicDir = path.join(root, "public");
  mkdirSync(path.join(clientDir, "assets"), { recursive: true });
  mkdirSync(path.join(clientDir, "docs"), { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(path.join(clientDir, "assets", "entry-abc123.js"), script);
  writeFileSync(path.join(clientDir, "client-only.txt"), "from the client build");
  writeFileSync(path.join(clientDir, "both.txt"), "from the client build");
  writeFileSync(path.join(clientDir, "docs", "readme.txt"), "a nested file");
  writeFileSync(path.join(publicDir, "public-only.txt"), "from public");
  writeFileSync(path.join(publicDir, "both.txt"), "from public");
  const app = createApp({
    build: { publicPath: "/" },
    clientDir,
    publicDir,
    // As in the image: express's own error handler logs only outside "test".
    mode: "production",
    handler: (req, res, next) => {
      handled.push(req.url ?? "");
      if (fail) return next(fail);
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain");
      res.end("the stub handler");
    },
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  handled = [];
  written = [];
  fail = undefined;
  const record = (...args: unknown[]) => {
    written.push(args.map((arg) => (arg instanceof Error ? `${arg.stack}` : String(arg))).join(" "));
  };
  for (const method of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(record);
  }
  const writeSpy = (chunk: unknown) => {
    record(chunk);
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(writeSpy);
  vi.spyOn(process.stderr, "write").mockImplementation(writeSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

function get(target: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: target, headers, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
      );
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("the web server", () => {
  it("serves /assets as immutable for a year, with no x-powered-by", async () => {
    const reply = await get(`/assets/entry-abc123.js?${marker}`);
    expect(reply.status).toBe(200);
    expect(reply.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(reply.headers["x-powered-by"]).toBeUndefined();
    expect(reply.body.toString()).toBe(script);
    expect(handled).toHaveLength(0);
  });

  it("gzips a compressible file when asked, and only then", async () => {
    const zipped = await get("/assets/entry-abc123.js", { "accept-encoding": "gzip" });
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(zipped.body).toString()).toBe(script);
    const plain = await get("/assets/entry-abc123.js", { "accept-encoding": "identity" });
    expect(plain.headers["content-encoding"]).toBeUndefined();
  });

  it("serves the build's client files with express's default cache header", async () => {
    const reply = await get("/client-only.txt");
    expect(reply.status).toBe(200);
    expect(reply.headers["cache-control"]).toBe("public, max-age=0");
    expect(reply.body.toString()).toBe("from the client build");
  });

  it("serves public/ for an hour, after the client files", async () => {
    const reply = await get("/public-only.txt");
    expect(reply.status).toBe(200);
    expect(reply.headers["cache-control"]).toBe("public, max-age=3600");
    expect(reply.body.toString()).toBe("from public");
    expect((await get("/both.txt")).body.toString()).toBe("from the client build");
  });

  it("redirects a folder without its slash, as express.static does", async () => {
    const reply = await get("/docs");
    expect(reply.status).toBe(301);
    expect(reply.headers.location).toBe("/docs/");
    expect(handled).toHaveLength(0);
  });

  it("hands a path no file answers to the request handler", async () => {
    const reply = await get(`/${marker}/no-such-page?${marker}=1`);
    expect(reply.status).toBe(404);
    expect(reply.body.toString()).toBe("the stub handler");
    expect(handled).toHaveLength(1);
    // A missing asset reaches the handler too, as with react-router-serve.
    expect((await get(`/assets/${marker}.js`)).body.toString()).toBe("the stub handler");
  });

  it("writes no line on stdout or stderr for any request", async () => {
    for (const target of [
      `/assets/entry-abc123.js?${marker}`,
      `/client-only.txt?${marker}`,
      `/public-only.txt?${marker}`,
      `/docs?${marker}`,
      `/${marker}/no-such-page`,
      `/${marker}/%E0%A4%A`, // an undecodable path: React Router would warn with it
      `/__manifest?paths=/a-${marker}/%E0%A4%A&version=1`, // an undecodable query value
    ]) {
      await get(target, { "accept-encoding": "gzip" });
    }
    expect(written).toHaveLength(0);
  });

  it("refuses a path or query that doesn't decode before anything else sees it, writing nothing", async () => {
    // Ruling 326: React Router's decodePath warns with the raw path, reachable
    // through the manifest route's `paths` query.
    for (const target of [
      `/${marker}/%E0%A4%A`,
      `/assets/${marker}%E0%A4%A.js`,
      `/__manifest?paths=/a-${marker}/%E0%A4%A&version=1`,
      `/__manifest?version=1&${marker}%E0=1`,
      `/page?${marker}=%`,
    ]) {
      const reply = await get(target);
      expect(reply.status).toBe(400);
      expect(reply.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      expect(reply.body.toString()).toBe("Bad Request");
    }
    expect(handled).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("hands a query with valid escapes to the request handler", async () => {
    const reply = await get(`/__manifest?paths=%2Fa-${marker}%2Fcaf%C3%A9%2C%2Fb&version=a+b&flag`);
    expect(reply.body.toString()).toBe("the stub handler");
    expect(handled).toHaveLength(1);
    expect(written).toHaveLength(0);
  });

  it("logs a failed request's error once, without the request's URL or path", async () => {
    fail = new Error(`the handler failed for /${marker}/page?${marker}=1`);
    const reply = await get(`/${marker}/page?${marker}=1`);
    expect(reply.status).toBe(500);
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.body.toString().includes(marker)).toBe(false);
    expect(written).toHaveLength(1);
    expect(written.join("\n").includes("the handler failed for")).toBe(true);
    expect(written.join("\n").includes(marker)).toBe(false);
  });
});

describe("the console.warn filter (Ruling 327)", () => {
  it("drops React Router's undecodable-path warning and passes every other call through unchanged", () => {
    const original = vi.fn();
    const target = { warn: original };
    const restore = installWarnFilter(target);
    // decodePath's shape, reached by a manifest `paths` value that decodes once only.
    target.warn(`The URL path "/a-${marker}/%E0%A4%A" could not be decoded because it is a malformed URL segment.`);
    target.warn(`Some other warning naming The URL path "x"`);
    target.warn(new Error("not a string"));
    target.warn("two", "args", 3);
    target.warn(" The URL path \"leading space\"");
    expect(original).toHaveBeenCalledTimes(4);
    expect(original.mock.calls.some((call) => call.some((arg) => String(arg).includes(marker)))).toBe(false);
    expect(original.mock.calls[0]).toEqual([`Some other warning naming The URL path "x"`]);
    expect(original.mock.calls[1]?.[0]).toBeInstanceOf(Error);
    expect(original.mock.calls[2]).toEqual(["two", "args", 3]);
    expect(original.mock.calls[3]).toEqual([' The URL path "leading space"']);
    restore();
    expect(target.warn).toBe(original);
  });
});
