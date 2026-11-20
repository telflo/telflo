import { readCapped, TOO_LARGE } from "../http/read-capped.js";
import {
  errorEnvelopeSchema,
  healthNotReadySchema,
  healthReadySchema,
  runAnswerSchema,
  type OtelcolTestingErrorCode,
  type RunAnswer,
  type TestRunErrorCode,
  type TestRunSignal,
} from "./schemas.js";

// The platform's client for the collector tester (the contract is
// services/otelcol-testing/openapi.yaml), as the validator's
// (otelcol-validator/client.ts): an injected fetch, one timer over the request
// and the reading of its reply, the shared secret as a Bearer token, redirects
// never followed, the reply read up to a cap.
//
// It never throws for anything the tester does or doesn't answer: a run the
// tester ran is `succeeded` or `failed`, and every other outcome is
// `unavailable`, with a reason. The reason tells the dispatcher whether the
// run may go back to the queue (`isReleasable`): only when the tester refused
// it before starting anything (503 `tester_busy`, `tester_starting`,
// `tester_unavailable`), or nothing was sent at all: the connection was
// refused, or the tester's name didn't resolve (ENOTFOUND, EAI_AGAIN). A
// timeout, a reset, any other status or a reply it can't read came after the
// run was sent, and may have run it: such a run is never released, so it is
// never sent twice. A duration the contract doesn't take (an integer from 1 to
// 60) is refused before anything is sent, and isn't released either: it would
// never be sent.
//
// The secret, the Authorization header, the text, the input and the output are
// never logged and never put in a result. The only lines it logs (at error
// level, through the optional `log`) are for what a deployment must fix: a 401
// (the tester doesn't take the secret), a status the run's contract doesn't
// expect (a 400, 409, 413 or 500, a redirect), a reply it can't read, and a
// duration it refused, with the reason, the status and the tester's error code
// from its envelope (the contract's fixed list), never the body. A version the
// tester's catalog retires (409 `version_retired`) or doesn't list (400
// `version_unknown`) is its own reason, each logged at warn.

/** One run, as the dispatcher sends it (openapi.yaml's RunRequest, the input as bytes). */
export interface TestRunRequest {
  /** The run's id: a label for the tester's log lines only. */
  runId: string;
  /** The configuration's text, as queued. Never logged. */
  yaml: string;
  /** The pipeline to run, as the text names it (`logs`, `logs/app`). */
  pipeline: string;
  signal: TestRunSignal;
  /** 1 to 60. */
  durationSeconds: number;
  /** The configuration's distribution: only `otelcol-contrib` is offered. */
  distribution: string;
  /** The pinned collector version, `major.minor.patch`. */
  version: string;
  /** The input's bytes, at most 10 MiB. Never logged. */
  input: Uint8Array;
}

/** The tester's answer, with its files decoded. */
export type TestRunAnswer = RunAnswer;

/**
 * Why a run has no answer. The comments say which may be released
 * (RELEASABLE_TESTER_REASONS): the tester refused it before starting
 * anything, so sending it again can't run it twice.
 */
export type TesterUnavailableReason =
  /** 503 `tester_busy`: no slot freed up within 5 s. Released. */
  | "busy"
  /** 503 `tester_starting`: kwok is still starting. Released. */
  | "starting"
  /** 503 `tester_unavailable`: kwok failed, the tester is about to restart. Released. */
  | "tester_unavailable"
  /** The connection was refused: nothing was sent. Released. */
  | "connection_refused"
  /** The tester's name didn't resolve (ENOTFOUND, EAI_AGAIN): nothing was sent. Released. */
  | "name_not_resolved"
  /** The caller's signal had ended the call before it was made (the API stopping): nothing was sent. Released. */
  | "not_sent"
  /** 503 `version_unavailable`: an offered version this tester doesn't hold. Not a health failure; the run fails. */
  | "version_unavailable"
  /**
   * 409 `version_retired`: the tester's catalog retires a version the
   * platform's still offers (the tester's image is newer than the
   * platform's catalog). The run fails with its own message; logged at
   * warn.
   */
  | "version_retired"
  /**
   * 400 `version_unknown`: the tester's catalog doesn't list the version
   * (its image is older than the platform's catalog). The run fails with
   * its own, neutral message; logged at warn.
   */
  | "version_unknown"
  /** No answer within 74 + d s, the reply's body included. */
  | "timeout"
  /** The caller's signal ended the call (the API shutting down), after it was sent. */
  | "aborted"
  /** The request or its reply broke off after the connection was made: reset, closed. */
  | "network"
  /** 401: the tester doesn't take TELFLO_OTELCOL_TESTING_SECRET. A deployment to fix; logged. */
  | "unauthorized"
  /** A 200 whose body isn't what openapi.yaml documents, or answers another version. Logged. */
  | "malformed_reply"
  /** A reply over MAX_OTELCOL_TESTING_REPLY_BYTES, never read past the cap. Logged. */
  | "oversized_reply"
  /** Any other status: a redirect, 400, 404, 409, 413, 500, a 503 without a known code, … Logged at error. */
  | "http_status"
  /** The run's duration isn't an integer from 1 to 60: nothing was sent, and it never could be. Logged. */
  | "invalid_request";

/** The reasons whose run goes back to the queue, keeping its place. */
export const RELEASABLE_TESTER_REASONS: ReadonlySet<TesterUnavailableReason> = new Set<TesterUnavailableReason>([
  "busy",
  "starting",
  "tester_unavailable",
  "connection_refused",
  "name_not_resolved",
  "not_sent",
]);

export type TestRunResult =
  /** The collector ran. */
  | { kind: "succeeded"; answer: TestRunAnswer }
  /** The tester ran the run and it failed: refused, the collector failed, … (`error` says which). */
  | { kind: "failed"; answer: TestRunAnswer; error: { code: TestRunErrorCode; message: string } }
  /**
   * No answer. `status` is the tester's when it answered one, `code` its
   * error envelope's when it had one. `isReleasable`: the tester ran nothing,
   * so the run may wait again (RELEASABLE_TESTER_REASONS).
   */
  | {
      kind: "unavailable";
      reason: TesterUnavailableReason;
      status?: number;
      code?: OtelcolTestingErrorCode;
      isReleasable: boolean;
    };

/** What `health()` answers. */
export type TesterHealthResult =
  /** 200: the tester and kwok are up. */
  | { kind: "up" }
  /**
   * A 503 `version_unavailable` envelope: the tester answered, and it is not
   * a health failure. The health route doesn't answer it today; a check that
   * gets one counts it as an answer.
   */
  | { kind: "version_unavailable" }
  /** Anything else: kwok starting or failed (503), no answer, a status or a body the contract doesn't give. */
  | {
      kind: "down";
      reason:
        | "starting"
        | "kwok_failed"
        | "timeout"
        | "network"
        | "connection_refused"
        | "name_not_resolved"
        | "http_status"
        | "malformed_reply";
      status?: number;
    };

export interface OtelcolTestingClient {
  /** Runs one test. Never throws for anything the tester does or doesn't answer. */
  run(request: TestRunRequest, options?: { signal?: AbortSignal }): Promise<TestRunResult>;
  /** Asks GET /testing/v1/health (no secret). Never throws. */
  health(options?: { signal?: AbortSignal }): Promise<TesterHealthResult>;
}

/** Where the client logs what a deployment must fix. A pino/Fastify logger fits. */
export interface OtelcolTestingClientLog {
  /** A version the tester no longer offers: the catalogs disagree for a while. */
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface OtelcolTestingClientOptions {
  /** The tester's base URL, e.g. `http://otelcol-testing:8002`. A trailing slash is dropped. */
  url: string;
  /** The shared secret. Never logged. */
  secret: string;
  /** Tests only; the global fetch by default. */
  fetch?: typeof fetch;
  /** Tests only; MAX_OTELCOL_TESTING_REPLY_BYTES by default. */
  maxReplyBytes?: number;
  /** Where a 401 or a reply it can't read is logged. Nothing is logged without it. */
  log?: OtelcolTestingClientLog;
}

/**
 * The client's single timer over a run's request and reply is 74 + d s, d
 * the run's duration: the tester's own request budget (64 + d s, a run's
 * deadline 57 + d s) and 10 s for carrying up to 32 MiB both ways. The
 * dispatcher's lease is 100 s longer (174 + d s): a 25 s send window, 30 s
 * for the files, the OTTL evaluator's 40 s and a 5 s margin (dispatcher.ts's
 * header).
 */
export const OTELCOL_TESTING_CLIENT_BASE_SECONDS = 74;

/** The durations the contract takes, in seconds (openapi.yaml's RunRequest). */
export const OTELCOL_TESTING_MINIMUM_DURATION_SECONDS = 1;
export const OTELCOL_TESTING_MAXIMUM_DURATION_SECONDS = 60;

/** True for a duration the contract takes: an integer from 1 to 60. */
export function isOtelcolTestingDuration(durationSeconds: number): boolean {
  return (
    Number.isInteger(durationSeconds) &&
    durationSeconds >= OTELCOL_TESTING_MINIMUM_DURATION_SECONDS &&
    durationSeconds <= OTELCOL_TESTING_MAXIMUM_DURATION_SECONDS
  );
}

/**
 * The run's timer, in milliseconds, for `durationSeconds`. Throws a
 * RangeError for a duration the contract doesn't take: a timer built from NaN
 * or a fraction fires at once or never.
 */
export function otelcolTestingRunTimeoutMs(durationSeconds: number): number {
  if (!isOtelcolTestingDuration(durationSeconds)) {
    throw new RangeError("A run's duration is an integer from 1 to 60 seconds.");
  }
  return (OTELCOL_TESTING_CLIENT_BASE_SECONDS + durationSeconds) * 1000;
}

/**
 * A health check's timer: 5 s, the tester's own probe taking 3 s. The monitor
 * waits its 5 s after each check ends, so checks never overlap.
 */
export const OTELCOL_TESTING_HEALTH_TIMEOUT_MS = 5_000;

/** The most of a reply the client reads: 32 MiB, the tester's own cap. */
export const MAX_OTELCOL_TESTING_REPLY_BYTES = 32 * 1024 * 1024;

/** A health reply is a few bytes; this bounds a stranger's. */
const MAX_HEALTH_REPLY_BYTES = 64 * 1024;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The error codes whose runs the tester refused before starting anything. */
const RELEASED_503_CODES: Readonly<Partial<Record<OtelcolTestingErrorCode, TesterUnavailableReason>>> = {
  tester_busy: "busy",
  tester_starting: "starting",
  tester_unavailable: "tester_unavailable",
  version_unavailable: "version_unavailable",
};

/** A version the tester's catalog doesn't offer, by its status and code. */
const VERSION_REPLIES: ReadonlyArray<readonly [number, OtelcolTestingErrorCode, "version_retired" | "version_unknown"]> = [
  [409, "version_retired", "version_retired"],
  [400, "version_unknown", "version_unknown"],
];

/** The reason a status and its envelope's code give, when they give one of their own. */
function knownReason(status: number, code: OtelcolTestingErrorCode | undefined): TesterUnavailableReason | undefined {
  if (code === undefined) return undefined;
  if (status === 503) return RELEASED_503_CODES[code];
  return VERSION_REPLIES.find(([versionStatus, versionCode]) => versionStatus === status && versionCode === code)?.[2];
}

/** The socket errors after which nothing was sent, and the reason each gives. */
const NOTHING_SENT_CODES: Readonly<Record<string, "connection_refused" | "name_not_resolved">> = {
  ECONNREFUSED: "connection_refused",
  // The name didn't resolve, for good or for now: no connection was made.
  ENOTFOUND: "name_not_resolved",
  EAI_AGAIN: "name_not_resolved",
};

/**
 * Why fetch failed before anything was sent, if it did: undici puts the
 * socket's or the resolver's error (ECONNREFUSED, ENOTFOUND, EAI_AGAIN) in
 * `cause`. Undefined for any other failure.
 */
function nothingSentReason(error: unknown): "connection_refused" | "name_not_resolved" | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && Object.hasOwn(NOTHING_SENT_CODES, code)) return NOTHING_SENT_CODES[code];
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The reasons logged at error level: each is a deployment's (or the platform's) to fix. */
const LOGGED_REASONS: ReadonlySet<TesterUnavailableReason> = new Set<TesterUnavailableReason>([
  "unauthorized",
  "malformed_reply",
  "oversized_reply",
  "http_status",
  "invalid_request",
]);

function unavailable(
  reason: TesterUnavailableReason,
  details: { status?: number; code?: OtelcolTestingErrorCode } = {},
): Extract<TestRunResult, { kind: "unavailable" }> {
  return { kind: "unavailable", reason, ...details, isReleasable: RELEASABLE_TESTER_REASONS.has(reason) };
}

/** Joins `signal` (the caller's: shutdown) to `controller` (the timer's). */
function follow(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  const onAbort = (): void => controller.abort();
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export function createOtelcolTestingClient(options: OtelcolTestingClientOptions): OtelcolTestingClient {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const maxReplyBytes = options.maxReplyBytes ?? MAX_OTELCOL_TESTING_REPLY_BYTES;
  const log = options.log;

  function logged(
    result: Extract<TestRunResult, { kind: "unavailable" }>,
  ): Extract<TestRunResult, { kind: "unavailable" }> {
    if (result.reason === "version_retired" || result.reason === "version_unknown") {
      log?.warn(
        {
          operation: "runTest",
          reason: result.reason,
          ...(result.status === undefined ? {} : { status: result.status }),
          ...(result.code === undefined ? {} : { code: result.code }),
        },
        "the collector tester doesn't offer a version the platform's catalogue does: rebuild the tester's image from the same catalogue",
      );
    } else if (LOGGED_REASONS.has(result.reason)) {
      // The status and the envelope's code (the contract's fixed list), never the body.
      log?.error(
        {
          operation: "runTest",
          reason: result.reason,
          ...(result.status === undefined ? {} : { status: result.status }),
          ...(result.code === undefined ? {} : { code: result.code }),
        },
        "the collector tester's answer can't be used: check TELFLO_OTELCOL_TESTING_URL and _SECRET, and the tester's version",
      );
    }
    return result;
  }

  async function run(request: TestRunRequest, runOptions: { signal?: AbortSignal } = {}): Promise<TestRunResult> {
    // Before any timer or byte: the database's check allows only
    // 1 to 60, so this is a bug's, never a person's.
    if (!isOtelcolTestingDuration(request.durationSeconds)) return logged(unavailable("invalid_request"));
    // Stopped before it was made: nothing is sent, so the run may wait again.
    if (runOptions.signal?.aborted) return unavailable("not_sent");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), otelcolTestingRunTimeoutMs(request.durationSeconds));
    const unfollow = follow(runOptions.signal, controller);
    // A failed fetch or read. Its error's own text is dropped: it can quote the request.
    const brokeOff = (error: unknown): Extract<TestRunResult, { kind: "unavailable" }> => {
      if (runOptions.signal?.aborted) return unavailable("aborted");
      if (controller.signal.aborted) return unavailable("timeout");
      return unavailable(nothingSentReason(error) ?? "network");
    };
    try {
      let response: Response;
      try {
        response = await doFetch(`${base}/testing/v1/runs`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.secret}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId: request.runId,
            yaml: request.yaml,
            pipeline: request.pipeline,
            signal: request.signal,
            durationSeconds: request.durationSeconds,
            distribution: request.distribution,
            version: request.version,
            input: { base64: Buffer.from(request.input.buffer, request.input.byteOffset, request.input.byteLength).toString("base64") },
          }),
          // The contract never answers one, and following it would send the secret on.
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        return brokeOff(error);
      }
      const { status } = response;

      if (status === 401) {
        // Its envelope's code, for the log line; a body that breaks off or
        // runs long loses only that.
        const replied: string | typeof TOO_LARGE = await readCapped(response, MAX_HEALTH_REPLY_BYTES).catch(
          (): typeof TOO_LARGE => TOO_LARGE,
        );
        const envelope = errorEnvelopeSchema.safeParse(typeof replied === "string" ? parseJson(replied) : undefined);
        return logged(unavailable("unauthorized", envelope.success ? { status, code: envelope.data.error.code } : { status }));
      }

      let text: string | typeof TOO_LARGE;
      try {
        text = await readCapped(response, maxReplyBytes);
      } catch (error) {
        return brokeOff(error);
      }
      if (text === TOO_LARGE) return logged(unavailable("oversized_reply", { status }));
      const body = parseJson(text);

      if (status !== 200) {
        const envelope = errorEnvelopeSchema.safeParse(body);
        const code = envelope.success ? envelope.data.error.code : undefined;
        return logged(unavailable(knownReason(status, code) ?? "http_status", code === undefined ? { status } : { status, code }));
      }

      const parsed = runAnswerSchema.safeParse(body);
      // An answer about another collector is no answer about this run.
      if (!parsed.success || parsed.data.collectorVersion !== request.version) {
        return logged(unavailable("malformed_reply", { status }));
      }
      const answer = parsed.data;
      if (answer.status === "succeeded") return { kind: "succeeded", answer };
      // The schema ties `error` to `failed`.
      return { kind: "failed", answer, error: answer.error! };
    } finally {
      clearTimeout(timer);
      unfollow();
    }
  }

  async function health(healthOptions: { signal?: AbortSignal } = {}): Promise<TesterHealthResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OTELCOL_TESTING_HEALTH_TIMEOUT_MS);
    const unfollow = follow(healthOptions.signal, controller);
    const brokeOff = (error: unknown): TesterHealthResult => {
      if (controller.signal.aborted && !healthOptions.signal?.aborted) return { kind: "down", reason: "timeout" };
      if (controller.signal.aborted) return { kind: "down", reason: "network" };
      return { kind: "down", reason: nothingSentReason(error) ?? "network" };
    };
    try {
      let response: Response;
      try {
        // No secret: the route takes none, and it needn't travel.
        response = await doFetch(`${base}/testing/v1/health`, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        return brokeOff(error);
      }
      const { status } = response;
      if (status !== 200 && status !== 503) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "down", reason: "http_status", status };
      }
      let text: string | typeof TOO_LARGE;
      try {
        text = await readCapped(response, MAX_HEALTH_REPLY_BYTES);
      } catch (error) {
        return brokeOff(error);
      }
      const body = text === TOO_LARGE ? undefined : parseJson(text);
      if (status === 200) {
        return healthReadySchema.safeParse(body).success ? { kind: "up" } : { kind: "down", reason: "malformed_reply", status };
      }
      const notReady = healthNotReadySchema.safeParse(body);
      if (notReady.success) {
        return { kind: "down", reason: notReady.data.kwok === "starting" ? "starting" : "kwok_failed", status };
      }
      const envelope = errorEnvelopeSchema.safeParse(body);
      if (envelope.success && envelope.data.error.code === "version_unavailable") return { kind: "version_unavailable" };
      return { kind: "down", reason: "http_status", status };
    } finally {
      clearTimeout(timer);
      unfollow();
    }
  }

  return { run, health };
}
