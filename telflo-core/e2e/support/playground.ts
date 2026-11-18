import { expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { E2E_ANALYTICS_WEB_URL, E2E_POSTHOG_STUB_URL, E2E_SAAS_WEB_URL } from "./environment.js";

// The playground's request invariant (D31-1 decision 22, Preflight ruling
// 17; Ruling 300): on every playground page and the blank public editor,
// the only requests are
// - the web's own documents and React Router's data requests for the
//   playground's own pages (`/playground…`, `/public-editor`), and its
//   scripts, styles, fonts, images, media and manifests (by resource type;
//   a script, style or worker also by its file's extension, a worker told
//   by the context's workers, as WebKit reports its script as "xhr"),
//   Vite's development paths, React Router's `/__manifest` and the static
//   schemas: GETs or HEADs of web-origin paths outside `/api/`; any other
//   web-origin fetch only of a playground page (Ruling 303);
// - and never, whatever its path or resource type, a web-origin answer
//   outside the playground's pages that is an HTML page or a redirect: a
//   server render is what reads the session (Ruling 310: `/editor/x.js`,
//   asked from inside the playground, renders the signed-in layout);
// - the `/api/` requests of PLAYGROUND_API_ALLOWLIST, exactly (a method and a
//   path pattern each, no query): an allowlist, not a deny-list;
// - analytics, per consent, to PostHog's origin only (the stub's, on the
//   analytics web server).
// Anything else is recorded as outside: another `/api/` request (a `/me`, a
// refresh, any read or write), a document or data read of another page (the
// visitor sent to /login or /app), a web-origin request of another method,
// or another origin. Paths are judged decoded (as many rounds as change
// them), so `/%61pi/…` is an `/api/` request too. A test that leaves the
// playground on purpose (the handoff's /register, /login and /app) says so
// with `leave()`: nothing after it is the playground's, and nothing is
// recorded. A recorder never holds a request's body or query, so it never
// holds a visitor's text.

/** One `/api/` request decision 22 allows: its method and its path's pattern. */
export interface AllowedApiRequest {
  method: string;
  pattern: RegExp;
  /** How the spec names it. */
  name: string;
}

/** Decision 22's exact list. */
export const PLAYGROUND_API_ALLOWLIST: readonly AllowedApiRequest[] = [
  { method: "POST", pattern: /^\/api\/public\/v1\/validate\/anonymous$/, name: "POST /api/public/v1/validate/anonymous" },
  { method: "GET", pattern: /^\/api\/v1\/published-flows$/, name: "GET /api/v1/published-flows" },
  { method: "GET", pattern: /^\/api\/v1\/published-flows\/[^/]+$/, name: "GET /api/v1/published-flows/:slug" },
];

/** What a recorder keeps of a request: its method, origin, path and kind (never its query or body). */
export interface RecordedPlaygroundRequest {
  method: string;
  origin: string;
  path: string;
  /**
   * A page's document, a React Router data read (`….data`), one of the
   * web's own files (a script, style, image, font, media or manifest), or
   * anything else (a fetch or XHR, judged by its path).
   */
  kind: "document" | "data" | "asset" | "other";
  /** The browser's resource type as Playwright reports it ("document", "script", "stylesheet", "fetch", "xhr", "other", …). */
  type?: string;
  /** A dedicated worker's script: its URL is one a worker of the context loaded (Playwright's `worker` events). */
  worker?: boolean;
  /** How the web answered, once it has: a redirect (301, 302, 303, 307, 308) or an HTML page is a server render. */
  response?: { status: number; html: boolean };
  /** The allowlist's name for an allowed `/api/` request; undefined for anything else. */
  allowedAs?: string;
}

export interface PlaygroundRequestRecorder {
  requests: RecordedPlaygroundRequest[];
  /** Each recorded request outside the invariant, as "METHOD origin path" (no query). */
  outside: () => string[];
  /** The allowed `/api/` requests seen, by the allowlist's names. */
  apiRequests: () => string[];
  /** The test leaves the playground on purpose: nothing from now on is recorded. */
  leave: () => void;
}

/** How many decoding rounds `decodedPath` makes at most: deeper than any spelling a client sends. */
const DECODING_ROUNDS = 8;

/**
 * One round of percent-decoding, tolerant (Ruling 303): each run of `%XX`
 * escapes is decoded as UTF-8 where it can be, else escape by escape for
 * the ASCII ones, so one malformed escape (`%ZZ`, a lone `%E0`) leaves the
 * rest decoded rather than all of it encoded.
 */
function decodedOnce(path: string): string {
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
        const code = Number.parseInt(hex, 16);
        return code < 0x80 ? String.fromCharCode(code) : escape;
      });
    }
  });
}

/** The deepest decoding of `path`: decoded again while that changes it, at most DECODING_ROUNDS rounds. */
export function decodedPath(path: string): string {
  let current = path;
  for (let round = 0; round < DECODING_ROUNDS; round += 1) {
    const next = decodedOnce(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** The redirect statuses (304 Not Modified is a cache's answer, not a redirect). */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The resource types a page loads as the web's own files (Ruling 303). */
const ASSET_TYPES = new Set(["script", "stylesheet", "image", "font", "media", "manifest"]);

/**
 * The web's own fetches that aren't a page's: React Router's route
 * discovery (`/__manifest`, its query the routes' paths) and the static
 * collector schemas Monaco reads (`/schemas/…`), decision 22's "static
 * schemas".
 */
function isWebOwnFetch(path: string): boolean {
  return path === "/__manifest" || path.startsWith("/schemas/");
}

/** Vite's own paths in development: its client, modules and dependencies (`/@vite/…`, `/@fs/…`, `/@id/…`, `/node_modules/…`). */
function isViteDevPath(path: string): boolean {
  return path.startsWith("/@") || path.startsWith("/node_modules/");
}

/**
 * A script, style or worker file by its path (Vite's source modules,
 * `/app/lib/editor/yaml.worker.ts`; a build's `/assets/….js`), for a
 * request the browser loads AS a script, a style or a worker only (Ruling
 * 310): a document, a data read or a fetch whose path ends so is still a
 * page's, and is judged as one.
 */
function isScriptOrStyleFile(request: RecordedPlaygroundRequest, path: string): boolean {
  const loadedAsFile = request.type === "script" || request.type === "stylesheet" || request.worker === true;
  return loadedAsFile && /\.(?:[cm]?[jt]sx?|css)$/.test(path);
}

/** Whether `path` (decoded, case aside) is one of the playground's pages, or its React Router data read. */
export function isPlaygroundPagePath(path: string): boolean {
  const page = decodedPath(path).toLowerCase().replace(/\.data$/, "");
  return /^\/playground(\/|$)/.test(page) || page === "/public-editor";
}

/** Whether `request` is within decision 22 (the PostHog stub counts only when `analytics` is on). */
export function isWithinPlaygroundInvariant(request: RecordedPlaygroundRequest, analytics: boolean): boolean {
  if (request.origin === "data:" || request.origin === "blob:") return true;
  // The playground runs on the SaaS pair, and the analytics server (D36-1 Preflight ruling 16).
  const webOrigins = analytics ? [E2E_SAAS_WEB_URL, E2E_ANALYTICS_WEB_URL] : [E2E_SAAS_WEB_URL];
  if (webOrigins.includes(request.origin)) {
    // Decoded and case aside, as the gateway's catch-all for `/api/` matches it (Rulings 282, 300): `/API/v1/…` and
    // `/%61pi/v1/…` are `/api/` requests too.
    const path = decodedPath(request.path).toLowerCase();
    if (path === "/api" || path.startsWith("/api/")) return request.allowedAs !== undefined;
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    // A server render outside the playground's pages (an HTML page or a redirect), whatever was asked: it reads
    // the session (Ruling 310).
    const rendered = request.response !== undefined && (request.response.html || REDIRECTS.has(request.response.status));
    if (rendered && !isPlaygroundPagePath(request.path)) return false;
    // The web's own files (Rulings 303, 310).
    if (request.kind === "asset" || isViteDevPath(path) || isScriptOrStyleFile(request, path) || isWebOwnFetch(path)) return true;
    // A document, a data read or any other fetch: only of a playground page (Rulings 300, 303); another page's
    // is the visitor sent off the playground.
    return isPlaygroundPagePath(request.path);
  }
  return analytics && request.origin === E2E_POSTHOG_STUB_URL;
}

/** The allowlist's name for a `/api/` request, undefined when it isn't in the list (a query is never allowed). */
export function allowedApiRequest(method: string, path: string, hasQuery: boolean): string | undefined {
  if (hasQuery) return undefined;
  return PLAYGROUND_API_ALLOWLIST.find((allowed) => allowed.method === method && allowed.pattern.test(path))?.name;
}

/**
 * Records every request `context` makes from now on, across navigations,
 * reloads and new pages (Playwright reports a request per redirect hop).
 * `analytics` allows the PostHog stub's origin (a test on the analytics
 * web server, after consent).
 */
export function recordPlaygroundRequests(context: BrowserContext, { analytics = false }: { analytics?: boolean } = {}): PlaygroundRequestRecorder {
  const requests: RecordedPlaygroundRequest[] = [];
  const recordedOf = new WeakMap<Request, RecordedPlaygroundRequest>();
  // Dedicated workers' script URLs (origin and path), from every page's `worker` events: how a worker's script is
  // told apart where WebKit reports its resource type as "xhr" (Ruling 310; probed in all three browsers). Firefox
  // reports a URL `new URL` refuses for a worker whose script failed to load: not a worker, then (Ruling 312).
  const workerFiles = new Set<string>();
  const watchWorkers = (page: Page) =>
    page.on("worker", (worker) => {
      if (!URL.canParse(worker.url())) return;
      const url = new URL(worker.url());
      workerFiles.add(`${url.origin}${url.pathname}`);
    });
  for (const page of context.pages()) watchWorkers(page);
  context.on("page", watchWorkers);
  let left = false;
  context.on("request", (request) => {
    if (left) return;
    const url = new URL(request.url());
    const origin = url.protocol === "data:" || url.protocol === "blob:" ? url.protocol : url.origin;
    const method = request.method();
    const type = request.resourceType();
    const kind = type === "document" ? "document" : url.pathname.endsWith(".data") ? "data" : ASSET_TYPES.has(type) ? "asset" : "other";
    const recorded: RecordedPlaygroundRequest = { method, origin, path: url.pathname, kind, type };
    const allowedAs = allowedApiRequest(method, url.pathname, url.search !== "");
    if (allowedAs !== undefined) recorded.allowedAs = allowedAs;
    requests.push(recorded);
    recordedOf.set(request, recorded);
  });
  // How the web answered: its status and whether it is an HTML page, never its body.
  context.on("response", (response) => {
    const recorded = recordedOf.get(response.request());
    if (recorded === undefined) return;
    const contentType = response.headers()["content-type"] ?? "";
    recorded.response = { status: response.status(), html: /^text\/html\b/i.test(contentType) };
  });
  // A worker's script is told by its URL alone (WebKit reports its type as "xhr", the others as "script").
  const judged = (request: RecordedPlaygroundRequest): RecordedPlaygroundRequest =>
    workerFiles.has(`${request.origin}${request.path}`) ? { ...request, worker: true } : request;
  return {
    requests,
    outside: () =>
      requests
        .filter((request) => !isWithinPlaygroundInvariant(judged(request), analytics))
        .map((request) => `${request.method} ${request.origin} ${request.origin === "data:" ? "" : request.path}`),
    apiRequests: () => requests.flatMap((request) => (request.allowedAs === undefined ? [] : [request.allowedAs])),
    leave: () => {
      left = true;
    },
  };
}

/**
 * Samples `probe` every 100 ms, at least `samples` times (so about
 * `samples` / 10 seconds, with no fixed sleep), and returns every answer:
 * for "nothing happens for a while" checks (Ruling 304), as a single look
 * could pass before the thing would happen.
 */
export async function sampled<T>(probe: () => T | Promise<T>, samples = 20): Promise<T[]> {
  const seen: T[] = [];
  await expect
    .poll(
      async () => {
        seen.push(await probe());
        return seen.length;
      },
      { intervals: [100], timeout: samples * 100 + 10_000 },
    )
    .toBeGreaterThanOrEqual(samples);
  return seen;
}
