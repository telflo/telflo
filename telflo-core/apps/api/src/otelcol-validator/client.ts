import { readCapped, TOO_LARGE } from "../http/read-capped.js";
import {
  errorEnvelopeSchema,
  validateResponseSchema,
  type ValidatorRequirement,
  type ValidatorValidationError,
} from "./schemas.js";

// The platform's client for the collector validator (the contract is
// services/otelcol-validator/openapi.yaml), mirroring the opamp-server's
// (opamp-server/client.ts): an injected fetch, one timer over the request
// and the reading of its reply, the shared secret as a Bearer token,
// redirects never followed.
//
// Unlike the opamp-server's, it never throws for an answer: every failure is
// `unavailable`, with a reason the caller logs. A timeout, a network error, a
// 401 (the validator doesn't take the platform's secret), a 404 or 409 (the
// catalogue and the validator's disagree), a 400 or 413, a 503 (busy, or the
// version isn't baked in), any other status, an answer its schema refuses and
// one over the size cap are all the same to the person: their text wasn't
// checked.
//
// The secret, the Authorization header and the text are never logged and
// never put in a result: this module logs nothing, and a result names a
// reason and a status only, never the validator's words.

/** What to check: the text, with one collector of the catalogue. */
export interface ValidateRequest {
  /** A catalogue distribution's id, e.g. `otelcol-contrib`. */
  distribution: string;
  /** One of its versions, `major.minor.patch`. */
  version: string;
  /** The configuration's text, as written. Never logged. */
  yaml: string;
  /**
   * The organization's values the text references, by name, which the
   * validator fills in before its checks. Configuration text: never logged.
   * Left out or empty, the body holds `yaml` alone.
   */
  organizationVariables?: ReadonlyMap<string, string> | undefined;
}

/**
 * Why the text wasn't checked. Every one is `unavailable` to the person;
 * the reason is for the log.
 */
export type ValidatorUnavailableReason =
  /** No answer within the timeout, the reply's body included. */
  | "timeout"
  /** The request or its reply broke off: refused, reset, unreachable. */
  | "network"
  /** 401: the validator doesn't take TELFLO_OTELCOL_VALIDATOR_SECRET. A deployment to fix. */
  | "unauthorized"
  /** 404: the validator's catalogue lists no such distribution or version. */
  | "not_found"
  /** 409: the validator's catalogue deprecated the version. */
  | "version_retired"
  /** 400: the validator refused the request as malformed. */
  | "invalid_request"
  /** 413: the body or its text is too large for the validator. */
  | "payload_too_large"
  /** 503 `version_unavailable`: an offered version whose collector this validator doesn't hold. */
  | "version_unavailable"
  /** 503 `validator_busy`: every slot stayed busy. */
  | "validator_busy"
  /** Any other 5xx, a 503 without its envelope included. */
  | "server_error"
  /** A status the contract doesn't give this operation (a redirect, a 2xx other than 200, …). */
  | "unexpected_status"
  /** A 200 whose body isn't what openapi.yaml documents, or answers another collector. A deployment to fix. */
  | "malformed_reply"
  /** A reply (a 200 or a 503) over MAX_OTELCOL_VALIDATOR_REPLY_BYTES, never read past the cap. */
  | "oversized_reply";

export type ValidateResult =
  /** The collector checked the text. `valid` is false exactly when `errors` isn't empty. */
  | {
      kind: "checked";
      valid: boolean;
      errors: ValidatorValidationError[];
      requirements: ValidatorRequirement[];
    }
  /** The text wasn't checked. `status` is the validator's, when it answered one. */
  | { kind: "unavailable"; reason: ValidatorUnavailableReason; status?: number };

export interface OtelcolValidatorClient {
  /** Checks the text; never throws for anything the validator does or doesn't answer. */
  validate(request: ValidateRequest): Promise<ValidateResult>;
}

export interface OtelcolValidatorClientOptions {
  /** The validator's base URL, e.g. `http://otelcol-validator:8001`. */
  url: string;
  /** The shared secret. Never logged. */
  secret: string;
  /** Tests only; the global fetch by default. */
  fetch?: typeof fetch;
  /** Tests only; MAX_OTELCOL_VALIDATOR_REPLY_BYTES by default. */
  maxReplyBytes?: number;
  /** How long a check may take, reading the reply included. Default 20,000. */
  timeoutMs?: number;
}

/**
 * A check the validator queues waits up to 5 s for a slot, then runs under
 * a 12 s deadline (the collector's 10 s and 2 s of margin), so the platform
 * waits 20 s before it gives up.
 */
export const DEFAULT_OTELCOL_VALIDATOR_TIMEOUT_MS = 20_000;

/**
 * The most of a reply the client reads: 4 MiB. The validator bounds its
 * answer (services/otelcol-validator, `app/runner.py`'s `bounded`): at most
 * 201 errors (200 and one saying more were reported), each message 4 KiB
 * and path 1 KiB, and at most 200 requirements of at most 6,270 bytes each,
 * so an answer is at most 2,290,356 bytes (about 2.18 MiB). A longer reply
 * is `oversized_reply`, the rest never read: the text wasn't checked, as
 * for any other failure.
 */
export const MAX_OTELCOL_VALIDATOR_REPLY_BYTES = 4 * 1024 * 1024;

/** The statuses whose meaning the status alone gives (openapi.yaml). */
const STATUS_REASONS: Readonly<Record<number, ValidatorUnavailableReason>> = {
  400: "invalid_request",
  401: "unauthorized",
  404: "not_found",
  409: "version_retired",
  413: "payload_too_large",
};

/**
 * The body: `yaml`, and the values when there are any. Built from entries,
 * never by assignment, so a variable named `__proto__` (the server's grammar
 * allows it) is a key like any other. Sent unescaped (JSON.stringify writes
 * every character as itself): 150 values of 1,024 four-byte characters are
 * 600 KiB, and with a text of 262,144 characters at their longest about
 * 1.4 MB, under the validator's 2 MiB.
 */
function requestBody(request: ValidateRequest): string {
  const values = request.organizationVariables;
  if (values === undefined || values.size === 0) return JSON.stringify({ yaml: request.yaml });
  return JSON.stringify({ yaml: request.yaml, organizationVariables: Object.fromEntries(values) });
}

export function createOtelcolValidatorClient(options: OtelcolValidatorClientOptions): OtelcolValidatorClient {
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OTELCOL_VALIDATOR_TIMEOUT_MS;
  const maxReplyBytes = options.maxReplyBytes ?? MAX_OTELCOL_VALIDATOR_REPLY_BYTES;

  return {
    async validate(request) {
      const url = `${base}/validator/v1/validate/${encodeURIComponent(request.distribution)}/${encodeURIComponent(request.version)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      /** A failed fetch or read: the timeout's, or the network's. Its own error's text is dropped: it can quote the request. */
      const brokeOff = (): ValidateResult =>
        controller.signal.aborted ? { kind: "unavailable", reason: "timeout" } : { kind: "unavailable", reason: "network" };
      try {
        let response: Response;
        try {
          response = await doFetch(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.secret}`,
              accept: "application/json",
              "content-type": "application/json",
            },
            body: requestBody(request),
            // The contract never answers one, and following it would send the secret on.
            redirect: "manual",
            signal: controller.signal,
          });
        } catch {
          return brokeOff();
        }
        const { status } = response;

        if (status !== 200 && status !== 503) {
          await response.body?.cancel().catch(() => undefined);
          const reason = STATUS_REASONS[status] ?? (status >= 500 ? "server_error" : "unexpected_status");
          return { kind: "unavailable", reason, status };
        }

        let text: string | typeof TOO_LARGE;
        try {
          text = await readCapped(response, maxReplyBytes);
        } catch {
          return brokeOff();
        }
        if (text === TOO_LARGE) return { kind: "unavailable", reason: "oversized_reply", status };
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = undefined;
        }

        if (status === 503) {
          // Which 503 it is, for the log; one without the envelope is a 5xx like any other.
          const envelope = errorEnvelopeSchema.safeParse(body);
          const code = envelope.success ? envelope.data.error.code : undefined;
          const reason = code === "version_unavailable" || code === "validator_busy" ? code : "server_error";
          return { kind: "unavailable", reason, status };
        }

        const parsed = validateResponseSchema.safeParse(body);
        // An answer about another collector is no answer about this text.
        if (!parsed.success || parsed.data.distribution !== request.distribution || parsed.data.version !== request.version) {
          return { kind: "unavailable", reason: "malformed_reply", status };
        }
        const { valid, errors, requirements } = parsed.data;
        return { kind: "checked", valid, errors, requirements };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
