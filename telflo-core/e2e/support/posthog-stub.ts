import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import { E2E_POSTHOG_STUB_URL } from "./environment.js";

// A stand-in for PostHog's host (D4 Preflight ruling 8), so nothing the
// analytics tests do leaves the machine. The analytics web server's
// TELFLO_POSTHOG_HOST points here (e2eAnalyticsWebEnv). It records every
// request it is sent, and answers `{}` to PostHog's JSON endpoints and empty
// JavaScript to its scripts: posthog-js then runs with no flags, no remote
// configuration and no recorder, and still captures once the visitor accepts.
//
// The browser tests read the record back over HTTP, from another process,
// each by its own tag (analytics.ts): every request an analytics test's
// browser sends carries the header TAG_HEADER with a tag of the test's own,
// so tests running at once, in three browsers, never see each other's
// requests.

/**
 * The header that names the test a request came from. A header rather than
 * the user agent: Firefox sends posthog-js's `keepalive` requests with its
 * own user agent, not the one Playwright sets, but with Playwright's extra
 * headers. (A CORS preflight may go without it; it carries nothing.)
 */
export const TAG_HEADER = "x-telflo-e2e-test";

/** Where the record is read, and the health check. Never a PostHog path. */
const RECORD_PATH = "/__stub/requests";
const HEALTH_PATH = "/__stub/health";

/** One request as the stub received it, its body decoded. */
export interface RecordedRequest {
  method: string;
  /** The path and query, as sent. */
  url: string;
  /** The path alone. */
  path: string;
  /** The TAG_HEADER's value, or "" without one. */
  tag: string;
  /** Every header, as a JSON string, for searching. */
  headers: string;
  /**
   * The body as text: gunzipped when posthog-js compressed it (`gzip-js`),
   * base64-decoded when it sent `data=<base64>`, as sent otherwise.
   */
  body: string;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/**
 * The body as posthog-js meant it. It gzips (by `CompressionStream` or
 * fflate) or base64-encodes a batch, depending on what its remote
 * configuration allows; the record keeps the text either way, so a search of
 * it finds what was sent.
 */
export function decodeBody(raw: Buffer, url: URL): string {
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      return gunzipSync(raw).toString("utf8");
    } catch {
      return raw.toString("latin1");
    }
  }
  const text = raw.toString("utf8");
  if (url.searchParams.get("compression") === "base64" || text.startsWith("data=")) {
    const data = new URLSearchParams(text).get("data");
    if (data !== null) return `${text}\n${Buffer.from(data, "base64").toString("utf8")}`;
  }
  return text;
}

/** Lets the page on another origin (localhost:23101) read the answers, credentials or not. */
function allowCors(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "*");
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    request.headers["access-control-request-headers"] ?? "Content-Type",
  );
  response.setHeader("Vary", "Origin");
}

/** Starts the stub on `port` (127.0.0.1). */
export function startPostHogStub({ port, hostname }: { port: number; hostname: string }): Promise<Server> {
  const recorded: RecordedRequest[] = [];

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${hostname}:${port}`);

      if (url.pathname === HEALTH_PATH) {
        response.end("ok");
        return;
      }
      if (url.pathname === RECORD_PATH) {
        const tag = url.searchParams.get("tag") ?? "";
        const matching = recorded.filter((entry) => entry.tag !== "" && entry.tag === tag);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(matching));
        return;
      }

      const raw = await readBody(request);
      recorded.push({
        method: request.method ?? "GET",
        url: url.pathname + url.search,
        path: url.pathname,
        tag: String(request.headers[TAG_HEADER] ?? ""),
        headers: JSON.stringify(request.headers),
        body: decodeBody(raw, url),
      });

      allowCors(request, response);
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
      } else if (url.pathname.endsWith(".js")) {
        response.setHeader("Content-Type", "application/javascript");
        response.end("");
      } else {
        response.setHeader("Content-Type", "application/json");
        response.end("{}");
      }
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => resolve(server));
  });
}

/** Every request the stub recorded from the browser carrying `tag`, in the order received. */
export async function recordedRequests(tag: string): Promise<RecordedRequest[]> {
  const response = await fetch(`${E2E_POSTHOG_STUB_URL}${RECORD_PATH}?tag=${encodeURIComponent(tag)}`);
  if (!response.ok) throw new Error(`The PostHog stub answered ${response.status} to its record`);
  return (await response.json()) as RecordedRequest[];
}
