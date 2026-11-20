import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { clientIpForAudit } from "./client-ip.js";
import { PUBLIC_DOWNLOAD_REFERRER_POLICY, sendPlainTextRefusal } from "./plain-text-refusal.js";
import { auditUserAgent } from "./audit-user-agent.js";

export { PUBLIC_DOWNLOAD_REFERRER_POLICY, sendPlainTextRefusal };

/*
 * The machinery of a public download: a route anyone holding a link may
 * call, with no session, no cookie and no CSRF header (a GET). The
 * quick-deploy download, the library's links and the public logo read use
 * it. A public route:
 *
 *   - attaches a per-IP limit as its `onRequest` hook
 *     (`rateLimiters.quickDeployPerIp`, rate-limits.ts), so every request
 *     counts before anything is looked up;
 *   - counts each attempt on the thing it found per key
 *     (`createPerKeyLimiter`, rate-limits.ts), by its id, never by the
 *     secret;
 *   - holds one of a few slots while it renders (`createInFlightCap`);
 *   - answers every refusal in plain text (`createPublicDownloadErrorHandler`'s
 *     handler, given the ids it may log, as its `errorHandler`), never
 *     naming the secret, a label or a name;
 *   - sends its bytes with `sendDownload`'s headers;
 *   - audits who downloaded with `requesterOf`;
 *   - is logged with its secret cut out (request-log.ts).
 */

/** At most this many public renders in flight per API process. */
export const PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT = 8;

/** A full cap's Retry-After: a render ends within seconds, so one is enough to wait. */
export const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

export const DOWNLOADS_BUSY_MESSAGE = "Too many downloads at once. Try again in a moment.";

/** The 503 a full cap answers, with Retry-After: 1. */
export function downloadsBusy(): AppError {
  return new AppError("downloads_busy", DOWNLOADS_BUSY_MESSAGE, 503, undefined, {
    "retry-after": IN_FLIGHT_RETRY_AFTER_SECONDS,
  });
}

/** A count of work in flight, at most `max` at once, in memory, per API process. */
export interface InFlightCap {
  /**
   * Runs `work` in one of the slots and frees it once `work` settles,
   * whether it resolves or throws. With every slot held, throws
   * `downloadsBusy()` (503, Retry-After: 1) without running it. The slot is
   * taken synchronously, so two calls never both take the last.
   */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** How many slots are held (for tests). */
  readonly held: number;
}

export function createInFlightCap(max: number): InFlightCap {
  if (!Number.isInteger(max) || max < 1) throw new Error("An in-flight cap needs at least one slot.");
  let held = 0;
  return {
    async run(work) {
      if (held >= max) throw downloadsBusy();
      held += 1;
      try {
        return await work();
      } finally {
        held -= 1;
      }
    },
    get held() {
      return held;
    },
  };
}

/** A download's file name: plain characters only, so the header needs no quoting or escaping. */
const DOWNLOAD_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Sends a download (the signed-in bundle's headers):
 * `content-type`, `attachment; filename="…"`, `cache-control: no-store`,
 * `x-content-type-options: nosniff` and `referrer-policy: no-referrer`.
 * The file name is the caller's fixed text (the method and the arch, never
 * a label or a name); one outside the plain charset throws.
 */
export function sendDownload(
  reply: FastifyReply,
  download: { fileName: string; body: Buffer; contentType?: string },
): FastifyReply {
  if (!DOWNLOAD_FILE_NAME.test(download.fileName)) throw new Error("A download's file name must be plain characters.");
  return reply
    .status(200)
    .header("content-type", download.contentType ?? "application/gzip")
    .header("content-disposition", `attachment; filename="${download.fileName}"`)
    .header("cache-control", "no-store")
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", PUBLIC_DOWNLOAD_REFERRER_POLICY)
    .send(download.body);
}

export const PUBLIC_DOWNLOAD_CLIENT_ERROR_MESSAGE = "The request was not valid.";
export const PUBLIC_DOWNLOAD_SERVER_ERROR_MESSAGE = "Something went wrong. Please try again.";

/** Ids a public route's refusal may log beside its code (a link's, once found): never a secret or its hash. */
export type PublicDownloadLogFields = Readonly<Record<string, string>>;

/**
 * A public route's `errorHandler`: every refusal in plain text. An
 * AppError answers its status, its message (the platform's fixed words)
 * and its headers (a 429's Retry-After, set by the per-IP hook on the
 * reply or carried by the error). Its 5xx are the route's expected
 * refusals (the cap's `downloads_busy`, the opamp-server or the templates
 * unavailable, values that can't be opened, a download that can't be
 * recorded: each cause logged where it happened, with its ids): logged at
 * warn with the code and `fieldsOf(request)`'s ids only, no stack.
 * Fastify's own 4xx answer generic words, logged at warn; anything else is
 * unexpected, logged at error in full and answered 500. The request log
 * already cuts the secret from the URL each line holds (request-log.ts);
 * nothing here adds the URL or a parameter to a line.
 */
export function createPublicDownloadErrorHandler(
  fieldsOf: (request: FastifyRequest) => PublicDownloadLogFields | undefined = () => undefined,
): (error: AppError | FastifyError, request: FastifyRequest, reply: FastifyReply) => void {
  return (error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.warn({ ...fieldsOf(request), code: error.code }, "public download refused");
      void sendPlainTextRefusal(reply, error.statusCode, error.message, error.headers);
      return;
    }
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn({ err: error }, "client error");
      void sendPlainTextRefusal(reply, error.statusCode, PUBLIC_DOWNLOAD_CLIENT_ERROR_MESSAGE);
      return;
    }
    request.log.error({ ...fieldsOf(request), err: error }, "unhandled error");
    void sendPlainTextRefusal(reply, 500, PUBLIC_DOWNLOAD_SERVER_ERROR_MESSAGE);
  };
}

/** A public route's `errorHandler` with no ids to log. */
export const publicDownloadErrorHandler = createPublicDownloadErrorHandler();

/** The most of a user agent a download's audit row keeps. */
export const REQUESTER_USER_AGENT_MAXIMUM_LENGTH = 512;

/** Who asked for a public download, for its audit row. */
export interface Requester {
  /** The client's address (`request.ip`, the trusted hops honoured), when it is a well-formed one. */
  ipAddress: string | undefined;
  /** The User-Agent's first 512 characters, when one was sent. */
  userAgent: string | undefined;
}

export function requesterOf(request: FastifyRequest): Requester {
  const userAgent = auditUserAgent(request);
  return {
    ipAddress: clientIpForAudit(request.ip),
    userAgent:
      typeof userAgent === "string" && userAgent !== "" ? userAgent.slice(0, REQUESTER_USER_AGENT_MAXIMUM_LENGTH) : undefined,
  };
}
