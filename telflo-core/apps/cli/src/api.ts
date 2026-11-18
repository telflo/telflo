/*
 * The CLI's one client of the platform's public API, `/api/public/v1`
 * (D27 decisions 16-18). Each command area keeps its own per-route calls
 * in `ops/*.ts` on top of `request` and `listAll` (Preflight ruling 22).
 *
 * - Headers: `Accept`, `Content-Type` with a body, `Authorization: Bearer
 *   <token>`, `X-Telflo-Org` (a person's token, every route but `/whoami`,
 *   `/orgs` and the anonymous validate: `organization: false`), and
 *   `User-Agent: telflo-cli/<version> node/<version> <platform>`.
 * - No redirect is followed (`redirect: "manual"`): a 3xx is fixed words,
 *   so the Authorization header never goes to another location.
 * - Every request has a timeout: 30 s, or the caller's (120 s for a test
 *   run's create and output).
 * - A 429 with `Retry-After` is retried after it (whole seconds; a bad value
 *   counts as 5; each wait capped at 60 s), at most 3 times, with one stderr
 *   note per wait (`writeNote`: JSON with `--json`). A 429 without one is
 *   not retried (Preflight ruling 10).
 * - Errors are fixed words (`ApiError`): the envelope's message, or the
 *   CLI's words for the status. Never a reply's body, a header or the token.
 */

import { ApiError } from "./api-error.js";
import { EXIT, ExitError, withoutTokens, writeNote } from "./output.js";
import { serverOrigin } from "./server.js";
import { VERSION } from "./version.js";

export { ApiError } from "./api-error.js";

/** The public surface's prefix (D25). */
export const PUBLIC_API_PREFIX = "/api/public/v1";

/** Every request's timeout but the long ones (decision 16). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** A test run's create and its output (decision 16). */
export const LONG_TIMEOUT_MS = 120_000;

/** Retries of one request after a 429 with `Retry-After` (decision 17). */
export const MAXIMUM_RATE_LIMIT_RETRIES = 3;
/** The longest one wait lasts, whatever `Retry-After` says. */
export const MAXIMUM_RETRY_WAIT_SECONDS = 60;
/** A `Retry-After` that isn't whole seconds counts as this. */
export const BAD_RETRY_AFTER_SECONDS = 5;

/** A paged list's page size (`/configurations` and `/fleets` take 1-100) and how many pages `listAll` follows. */
export const PAGE_LIMIT = 100;
export const MAXIMUM_PAGES = 100;

/** The largest JSON reply the CLI reads (Ruling 237). */
export const MAXIMUM_REPLY_BYTES = 16 * 1024 * 1024;
/** The largest text reply (`text: true`: a test run's output may be large). */
export const MAXIMUM_TEXT_REPLY_BYTES = 32 * 1024 * 1024;

/** The API's words beyond this length are cut: a reply's message is shown, never trusted to be short. */
const MAXIMUM_MESSAGE_LENGTH = 500;

export const REDIRECT_MESSAGE = (status: number): string =>
  `The server answered with a redirect (HTTP ${status}), which the CLI doesn't follow. Check the server's address.`;
export const TOO_LARGE_MESSAGE = "The request is larger than the server accepts.";
export const BAD_GATEWAY_MESSAGE = "The server couldn't be reached (502).";
export const GATEWAY_TIMEOUT_MESSAGE = "The server took too long (504).";
export const UNEXPECTED_REPLY_MESSAGE = (status: number): string => `Unexpected reply (HTTP ${status}).`;
export const UNREACHABLE_MESSAGE = (origin: string): string => `Couldn't reach ${origin}.`;
export const TIMEOUT_MESSAGE = (timeoutMs: number): string =>
  `The server didn't answer within ${Math.round(timeoutMs / 1000)} s.`;
export const RATE_LIMITED_MESSAGE = (seconds: number): string => `Rate limited: try again in ${seconds} s.`;
export const RATE_LIMIT_WAIT_LINE = (seconds: number): string => `Rate limited: retrying in ${seconds} s.`;
export const TOO_MANY_PAGES_MESSAGE = `The list is longer than ${MAXIMUM_PAGES} pages: the CLI stops there.`;
export const REPEATED_CURSOR_MESSAGE = "The server answered the same page twice: the CLI stops there.";
export const REPLY_TOO_LARGE_MESSAGE = "The reply was larger than expected.";

/** A call's options; `bytes: true` answers a `Buffer`, `text: true` a string, otherwise the reply's JSON. */
export interface RequestOptions {
  /** Sent as JSON. */
  body?: unknown;
  /** Query parameters; `undefined` values are left out. */
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** This request's timeout (each attempt's). */
  timeoutMs?: number;
  /** `false`: no `X-Telflo-Org` (`/whoami`, `/orgs`, the anonymous validate). */
  organization?: boolean;
  /** The reply's text as is (a test run's output) instead of its JSON. */
  text?: boolean;
  /**
   * The reply's bytes exactly, as a `Buffer` (Ruling 238: a test run's
   * output, byte for byte: a BOM and invalid UTF-8 kept), under the text
   * reply's 32 MiB cap. Takes precedence over `text`.
   */
  bytes?: boolean;
}

export interface ClientOptions {
  /** The server's origin, as `serverOrigin` answers it. */
  server: string;
  /** None: the client calls the open routes only. */
  token?: string | undefined;
  /** The organization a person's token acts in, for `X-Telflo-Org`; absent for a service account's. */
  organizationId?: (() => Promise<string | undefined>) | undefined;
  fetch?: typeof fetch;
  /** Waits between a 429 and its retry (a test's fake clock). */
  sleep?: (milliseconds: number) => Promise<void>;
}

/** A paged list's reply (`/configurations`, `/fleets`). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** The User-Agent every request sends (decision 16). */
export function userAgent(): string {
  return `telflo-cli/${VERSION} node/${process.versions.node} ${process.platform}`;
}

/**
 * One path segment, percent-encoded (decision 16). A `.` or `..` segment is
 * refused: the URL parser would resolve it (even as `%2E`), moving the
 * request to another route.
 */
export function segment(value: string): string {
  if (isDotSegment(value)) throw new ExitError("A name or id can't be . or ..", EXIT.USAGE);
  return encodeURIComponent(value);
}

/** A pipeline's name as route 14's wildcard takes it: each `/` kept, everything else encoded. */
export function pipelineSegment(name: string): string {
  if (name.split("/").some(isDotSegment)) throw new ExitError("A pipeline's name can't hold a . or .. part.", EXIT.USAGE);
  return encodeURIComponent(name).replace(/%2F/gi, "/");
}

function isDotSegment(value: string): boolean {
  return value === "." || value === "..";
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Control characters out, tokens out, length capped: a reply's message reaches a terminal. */
function printable(message: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = withoutTokens(message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim());
  return flat.length > MAXIMUM_MESSAGE_LENGTH ? `${flat.slice(0, MAXIMUM_MESSAGE_LENGTH)}…` : flat;
}

interface Envelope {
  error: { code: string; message: string; details?: unknown };
}

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string";
}

/**
 * A JSON reply parsed, one leading BOM (U+FEFF) dropped first (Ruling 242):
 * JSON.parse refuses one, and a proxy may add it. Only here: `bytes: true`
 * answers the bytes as they came, and `text: true` keeps its text whole.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
}

/** A refusal's words: the envelope's when the reply is one, else the status's (decision 18). */
function refusalOf(status: number, isJson: boolean, text: string): ApiError {
  const parsed = isJson ? parseJson(text) : undefined;
  if (isEnvelope(parsed)) {
    return new ApiError(status, parsed.error.code, printable(parsed.error.message), parsed.error.details);
  }
  if (status === 413) return new ApiError(status, null, TOO_LARGE_MESSAGE);
  if (status === 502) return new ApiError(status, null, BAD_GATEWAY_MESSAGE);
  if (status === 504) return new ApiError(status, null, GATEWAY_TIMEOUT_MESSAGE);
  return new ApiError(status, null, UNEXPECTED_REPLY_MESSAGE(status));
}

/** `Retry-After` in whole seconds; a bad value counts as 5; null when there is none (decision 17). */
export function retryAfterSecondsOf(header: string | null): number | null {
  if (header === null) return null;
  const value = header.trim();
  return /^\d{1,9}$/.test(value) ? Number(value) : BAD_RETRY_AFTER_SECONDS;
}

interface Reply {
  status: number;
  isJson: boolean;
  bytes: Buffer;
  text: string;
  retryAfter: string | null;
}

export class ApiClient {
  readonly server: string;
  readonly #token: string | undefined;
  readonly #organizationId: (() => Promise<string | undefined>) | undefined;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: ClientOptions) {
    // The HTTPS rule holds here too: a client is only ever made for an origin the rule accepts.
    if (serverOrigin(options.server) !== options.server) {
      throw new ExitError("The server must be an origin such as https://telflo.example.com.", EXIT.USAGE);
    }
    this.server = options.server;
    this.#token = options.token;
    this.#organizationId = options.organizationId;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** Whether the client holds a token (an anonymous client calls the open routes only). */
  get authenticated(): boolean {
    return this.#token !== undefined;
  }

  /**
   * One call: `path` below the prefix (its segments already encoded with
   * `segment`). Answers the reply's JSON (undefined for an empty reply), or
   * its text with `text: true`; throws ApiError or ExitError in fixed words.
   */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.server}${PUBLIC_API_PREFIX}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      accept: options.bytes === true || options.text === true ? "text/plain, application/json" : "application/json",
      "user-agent": userAgent(),
    };
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
    if (options.organization !== false && this.#organizationId !== undefined) {
      const organizationId = await this.#organizationId();
      if (organizationId !== undefined) headers["x-telflo-org"] = organizationId;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    for (let retries = 0; ; retries += 1) {
      const maximumBytes = options.bytes === true || options.text === true ? MAXIMUM_TEXT_REPLY_BYTES : MAXIMUM_REPLY_BYTES;
      const reply = await this.#send(url, { method, headers, body }, timeoutMs, maximumBytes);
      if (reply.status >= 300 && reply.status < 400) throw new ApiError(reply.status, null, REDIRECT_MESSAGE(reply.status));
      if (reply.status === 429) {
        const seconds = retryAfterSecondsOf(reply.retryAfter);
        // No Retry-After (`test_run_queue_full`): its own words, never retried.
        if (seconds === null) throw refusalOf(reply.status, reply.isJson, reply.text);
        if (retries >= MAXIMUM_RATE_LIMIT_RETRIES) {
          throw new ApiError(429, "rate_limited", RATE_LIMITED_MESSAGE(seconds));
        }
        const wait = Math.min(seconds, MAXIMUM_RETRY_WAIT_SECONDS);
        writeNote(RATE_LIMIT_WAIT_LINE(wait));
        await this.#sleep(wait * 1000);
        continue;
      }
      if (reply.status < 200 || reply.status >= 300) throw refusalOf(reply.status, reply.isJson, reply.text);
      if (options.bytes === true) return reply.bytes as T;
      if (options.text === true) return reply.text as T;
      if (reply.status === 204 || reply.text === "") return undefined as T;
      const parsed = reply.isJson ? parseJson(reply.text) : undefined;
      if (parsed === undefined) throw new ApiError(reply.status, null, UNEXPECTED_REPLY_MESSAGE(reply.status));
      return parsed as T;
    }
  }

  /**
   * A paged list (`/configurations`, `/fleets`), every page: `limit=100`,
   * following `nextCursor`, at most 100 pages (decision 16). Not for the
   * unpaged lists (`/orgs`, groups, pipelines), whose strict queries take no
   * `limit`.
   */
  async listAll<T>(path: string, options: Omit<RequestOptions, "body" | "text"> = {}): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
      const reply = await this.request<Page<T> | undefined>("GET", path, {
        ...options,
        query: { ...options.query, limit: PAGE_LIMIT, cursor },
      });
      if (reply === undefined || !Array.isArray(reply.items)) throw new ApiError(200, null, UNEXPECTED_REPLY_MESSAGE(200));
      items.push(...reply.items);
      if (typeof reply.nextCursor !== "string") return items;
      if (seen.has(reply.nextCursor)) throw new ExitError(REPEATED_CURSOR_MESSAGE, EXIT.API);
      seen.add(reply.nextCursor);
      cursor = reply.nextCursor;
    }
    throw new ExitError(TOO_MANY_PAGES_MESSAGE, EXIT.API);
  }

  /** One attempt, its body read (at most `maximumBytes`) within the timeout; a network failure or the timeout as fixed words. */
  async #send(
    url: URL,
    init: { method: string; headers: Record<string, string>; body: string | undefined },
    timeoutMs: number,
    maximumBytes: number,
  ): Promise<Reply> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
        signal: controller.signal,
      });
      const bytes = await readCapped(response, maximumBytes);
      return {
        status: response.status,
        isJson: (response.headers.get("content-type") ?? "").toLowerCase().includes("json"),
        text: bytes.toString("utf8"),
        bytes,
        retryAfter: response.headers.get("retry-after"),
      };
    } catch (error) {
      if (error instanceof ExitError) throw error;
      // Never the error's own text: it can name the URL, and a URL is never printed whole.
      if (timedOut) throw new ExitError(TIMEOUT_MESSAGE(timeoutMs), EXIT.API, "timeout");
      throw new ExitError(UNREACHABLE_MESSAGE(this.server), EXIT.API, "unreachable");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A reply's body as bytes, refused (exit 1) past `maximumBytes`: what it says or what it streams. */
async function readCapped(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel();
    throw new ExitError(REPLY_TOO_LARGE_MESSAGE, EXIT.API, "reply_too_large");
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ExitError(REPLY_TOO_LARGE_MESSAGE, EXIT.API, "reply_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
