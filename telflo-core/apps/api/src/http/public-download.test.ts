import Fastify, { type FastifyInstance, type FastifyRequest, type LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AppError, registerErrorHandling } from "../errors.js";
import {
  createInFlightCap,
  createPublicDownloadErrorHandler,
  DOWNLOADS_BUSY_MESSAGE,
  type InFlightCap,
  PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT,
  PUBLIC_DOWNLOAD_SERVER_ERROR_MESSAGE,
  publicDownloadErrorHandler,
  requesterOf,
  sendDownload,
} from "./public-download.js";
import { RATE_LIMITED_MESSAGE, registerRateLimits, TEST_RATE_LIMITS, type RateLimits } from "./rate-limits.js";
import { QUICK_DEPLOY_ROUTE, serializeRequest } from "./request-log.js";

/** Lets every pending callback run once: a bound on waiting, counted in turns, never in milliseconds. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(condition: () => boolean, turns = 1_000): Promise<void> {
  for (let turn = 0; turn < turns && !condition(); turn += 1) await nextTurn();
  if (!condition()) throw new Error(`not reached within ${turns} turns`);
}

/** A settable gate: the work waits on `opened` until `open()`. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("createInFlightCap (D17c-2 decision 26)", () => {
  it("is 8 for the public renders", () => {
    expect(PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT).toBe(8);
  });

  it("runs up to max at once, refuses the next 503 Retry-After: 1 without running it, and lets one in once a slot is freed", async () => {
    const cap = createInFlightCap(PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT);
    const { opened, open } = gate();
    const running = Array.from({ length: PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT }, () => cap.run(() => opened));
    expect(cap.held).toBe(8);

    let ran = false;
    await expect(
      cap.run(async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ statusCode: 503, message: DOWNLOADS_BUSY_MESSAGE, headers: { "retry-after": 1 } });
    expect(ran).toBe(false);
    expect(cap.held).toBe(8);

    open();
    await Promise.all(running);
    expect(cap.held).toBe(0);
    await expect(cap.run(async () => "done")).resolves.toBe("done");
  });

  it("frees the slot when the work throws", async () => {
    const cap = createInFlightCap(1);
    await expect(
      cap.run(async () => {
        throw new Error("render failed");
      }),
    ).rejects.toThrow("render failed");
    expect(cap.held).toBe(0);
    await expect(cap.run(async () => 1)).resolves.toBe(1);
  });

  it("refuses a cap of no slot", () => {
    expect(() => createInFlightCap(0)).toThrow();
    expect(() => createInFlightCap(1.5)).toThrow();
  });
});

describe("requesterOf (D17c-2 decision 9, Preflight ruling 13)", () => {
  const requestFrom = (ip: string, userAgent?: string | string[]) =>
    ({ ip, headers: userAgent === undefined ? {} : { "user-agent": userAgent } }) as unknown as FastifyRequest;

  it("gives the client's address and its user agent", () => {
    expect(requesterOf(requestFrom("203.0.113.7", "curl/8.5.0"))).toEqual({ ipAddress: "203.0.113.7", userAgent: "curl/8.5.0" });
    expect(requesterOf(requestFrom("2001:db8::1", "curl/8.5.0"))).toMatchObject({ ipAddress: "2001:db8::1" });
  });

  it("leaves out an address that isn't one, and an absent or empty user agent", () => {
    expect(requesterOf(requestFrom("not-an-address"))).toEqual({ ipAddress: undefined, userAgent: undefined });
    expect(requesterOf(requestFrom("203.0.113.7", ""))).toEqual({ ipAddress: "203.0.113.7", userAgent: undefined });
  });

  it("keeps a user agent's first 512 characters", () => {
    const long = "a".repeat(511) + "bc";
    expect(requesterOf(requestFrom("203.0.113.7", long)).userAgent).toBe("a".repeat(511) + "b");
  });
});

/*
 * The machinery on a throwaway route, as the public download will use it
 * (D17c-2 Preflight ruling 10; Task 3 registers the real one): the per-IP
 * hook first, then the route's own checks (an unknown secret 404), the
 * per-link count, the in-flight cap, the download. Every refusal in plain
 * text, the secret in no log line.
 */
const KNOWN_SECRET = "tqd_CANARYCANARYCANARYCANARYCANARYCANARYCANARY0";
const OTHER_SECRET = "tqd_OTHERCANARYOTHERCANARYOTHERCANARYOTHERCAN";
const ARCHIVE = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);

describe("a public route's hooks (D17c-2 decisions 9, 26 and 27)", () => {
  let servers: FastifyInstance[] = [];
  let lines: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
    lines = [];
  });

  /** A server with the API's error handling, its limits (small ones as given) and the stand-in route. */
  async function serve(limits: Partial<RateLimits>, options: { cap?: InFlightCap; render?: () => Promise<void> } = {}) {
    const server = Fastify({
      logger: { level: "info", serializers: { req: serializeRequest }, stream: { write: (line: string) => void lines.push(line) } },
    });
    registerErrorHandling(server);
    const rateLimiters = registerRateLimits(server, { ...TEST_RATE_LIMITS, ...limits });
    const cap = options.cap ?? createInFlightCap(PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT);
    server.get<{ Params: { secret: string } }>(
      QUICK_DEPLOY_ROUTE,
      { onRequest: rateLimiters.quickDeployPerIp, errorHandler: publicDownloadErrorHandler, exposeHeadRoute: false },
      async (request, reply) => {
        if (request.params.secret !== KNOWN_SECRET) throw new AppError("quick_deploy_link_not_found", "Install link not found.", 404);
        rateLimiters.quickDeployPerLink.count("link-1");
        await cap.run(async () => {
          await options.render?.();
        });
        return sendDownload(reply, { fileName: "telflo-collector-aio-amd64.tar.gz", body: ARCHIVE });
      },
    );
    server.get("/api/v1/broken", { errorHandler: publicDownloadErrorHandler }, async () => {
      throw new Error("an internal failure");
    });
    // A route that knows its link's ids, refusing as the quick-deploy route's expected 5xx do, or failing unexpectedly.
    const withIds = createPublicDownloadErrorHandler(() => ({ organizationId: "org-1", linkId: "link-1" }));
    server.get("/api/v1/unavailable", { errorHandler: withIds }, async () => {
      throw new AppError("quick_deploy_unavailable", "Downloads aren't available right now. Try again in a moment.", 503);
    });
    server.get("/api/v1/broken-with-ids", { errorHandler: withIds }, async () => {
      throw new Error("an internal failure");
    });
    await server.ready();
    servers.push(server);
    return server;
  }

  const download = (server: FastifyInstance, secret: string, remoteAddress = "203.0.113.7") =>
    server.inject({ method: "GET", url: `/api/v1/quick-deploy/${secret}`, remoteAddress, headers: { "user-agent": "curl/8.5.0" } });

  const expectPlainText = (response: LightMyRequestResponse, statusCode: number, text: string) => {
    expect(response.statusCode).toBe(statusCode);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    // Ruling 31: every refusal, the 429s and the cap's 503 included.
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.body).toBe(`${text}\n`);
  };

  const expectNoSecretLogged = () => {
    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join("\n");
    expect(logged).not.toContain("CANARY");
  };

  it("sends a download with the headers: gzip, attachment, no-store, nosniff, no-referrer", async () => {
    const server = await serve({});
    const response = await download(server, KNOWN_SECRET);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/gzip");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="telflo-collector-aio-amd64.tar.gz"');
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.rawPayload.equals(ARCHIVE)).toBe(true);
    expectNoSecretLogged();
  });

  it("answers no HEAD: the route's handler never runs for one", async () => {
    const server = await serve({});
    const response = await server.inject({ method: "HEAD", url: `/api/v1/quick-deploy/${KNOWN_SECRET}` });
    expect(response.statusCode).toBe(404);
  });

  it("counts every request per IP, unknown secrets included, and answers past the limit 429 in plain text with Retry-After", async () => {
    const server = await serve({ quickDeployPerIp: { max: 3, windowMs: 60_000 } });
    for (const secret of [OTHER_SECRET, "not-a-secret", OTHER_SECRET]) {
      expectPlainText(await download(server, secret), 404, "Install link not found.");
    }
    // The known link's first request from that address is past the address's three.
    const limited = await download(server, KNOWN_SECRET);
    expectPlainText(limited, 429, RATE_LIMITED_MESSAGE);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Another address has its own count.
    expect((await download(server, KNOWN_SECRET, "198.51.100.9")).statusCode).toBe(200);
    expectNoSecretLogged();
  });

  it("counts every download of a link, from any address, and answers past the limit 429 in plain text with Retry-After", async () => {
    const server = await serve({ quickDeployPerLink: { max: 2, windowMs: 60_000 } });
    expect((await download(server, KNOWN_SECRET, "203.0.113.1")).statusCode).toBe(200);
    expect((await download(server, KNOWN_SECRET, "203.0.113.2")).statusCode).toBe(200);
    const limited = await download(server, KNOWN_SECRET, "203.0.113.3");
    expectPlainText(limited, 429, RATE_LIMITED_MESSAGE);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Unknown secrets are no link's: they spend nothing of it.
    expect((await download(server, OTHER_SECRET, "203.0.113.4")).statusCode).toBe(404);
    expectNoSecretLogged();
  });

  it("holds 8 renders in flight; the 9th is 503 in plain text with Retry-After: 1, and once they end another is served", async () => {
    const cap = createInFlightCap(PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT);
    const { opened, open } = gate();
    const server = await serve({}, { cap, render: () => opened });
    const first = Array.from({ length: PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT }, () => download(server, KNOWN_SECRET));
    await until(() => cap.held === PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT);

    const busy = await download(server, KNOWN_SECRET);
    expectPlainText(busy, 503, DOWNLOADS_BUSY_MESSAGE);
    expect(busy.headers["retry-after"]).toBe("1");

    open();
    for (const response of await Promise.all(first)) expect(response.statusCode).toBe(200);
    expect(cap.held).toBe(0);
    expect((await download(server, KNOWN_SECRET)).statusCode).toBe(200);
    expectNoSecretLogged();
  });

  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  it("answers an unexpected failure 500 in plain text with generic words, logging it at error with its stack", async () => {
    const server = await serve({});
    const response = await server.inject({ method: "GET", url: "/api/v1/broken" });
    expectPlainText(response, 500, PUBLIC_DOWNLOAD_SERVER_ERROR_MESSAGE);
    expect(parsed().filter((line) => line.msg === "unhandled error")).toEqual([
      expect.objectContaining({ level: 50, err: expect.objectContaining({ stack: expect.stringContaining("an internal failure") }) }),
    ]);
    // With the route's ids beside it.
    lines = [];
    expectPlainText(await server.inject({ method: "GET", url: "/api/v1/broken-with-ids" }), 500, PUBLIC_DOWNLOAD_SERVER_ERROR_MESSAGE);
    expect(parsed().filter((line) => line.msg === "unhandled error")).toEqual([
      expect.objectContaining({ level: 50, organizationId: "org-1", linkId: "link-1", err: expect.objectContaining({ stack: expect.any(String) }) }),
    ]);
  });

  it("logs an expected 5xx refusal (an AppError) at warn with its code and the route's ids only, no stack (Ruling 36)", async () => {
    const server = await serve({});
    expectPlainText(await server.inject({ method: "GET", url: "/api/v1/unavailable" }), 503, "Downloads aren't available right now. Try again in a moment.");
    const refused = parsed().filter((line) => line.msg === "public download refused");
    expect(refused).toEqual([expect.objectContaining({ level: 40, code: "quick_deploy_unavailable", organizationId: "org-1", linkId: "link-1" })]);
    expect(Object.keys(refused[0]!)).not.toContain("err");
    expect(parsed().filter((line) => (line.level as number) >= 50)).toEqual([]);
    // The cap's 503, on a route with no ids: the code alone.
    lines = [];
    const cap = createInFlightCap(1);
    const { opened, open } = gate();
    const busyServer = await serve({}, { cap, render: () => opened });
    const first = download(busyServer, KNOWN_SECRET);
    await until(() => cap.held === 1);
    expectPlainText(await download(busyServer, KNOWN_SECRET), 503, DOWNLOADS_BUSY_MESSAGE);
    open();
    expect((await first).statusCode).toBe(200);
    expect(parsed().filter((line) => line.msg === "public download refused")).toEqual([expect.objectContaining({ level: 40, code: "downloads_busy" })]);
    expect(parsed().filter((line) => line.err !== undefined || (line.level as number) >= 50)).toEqual([]);
  });

  it("refuses a file name outside the plain charset", async () => {
    const server = Fastify({ logger: false });
    server.get("/x", async (_request, reply) => sendDownload(reply, { fileName: 'a".tar.gz', body: ARCHIVE }));
    servers.push(server);
    const response = await server.inject({ method: "GET", url: "/x" });
    expect(response.statusCode).toBe(500);
  });
});
