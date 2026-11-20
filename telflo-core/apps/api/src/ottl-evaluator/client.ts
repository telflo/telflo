import type { OttlContext, TestRunSignal, ValidationRuleKind, ValidationRuleOttl, ValidationRuleTarget } from "@telflo/contracts";
import { z } from "zod";
import { readCapped, TOO_LARGE } from "../http/read-capped.js";
import {
  errorEnvelopeSchema,
  evaluateAnswerSchema,
  healthSchema,
  lintAnswerSchema,
  validateAnswerSchema,
  type OttlEvaluatorErrorCode,
  type OttlLintKind,
  type OttlEvaluatorProblem,
  type OttlEvaluatorResult,
} from "./schemas.js";

// The platform's client for the OTTL evaluator (the contract is
// services/ottl-evaluator/openapi.yaml), as the tester's
// (otelcol-testing/client.ts): an injected fetch, one timer over the request
// and the reading of its reply, the shared secret as a Bearer token,
// redirects never followed, the reply read up to a cap.
//
// It never throws for anything the evaluator does or doesn't answer:
// - evaluate (a run's rules, after the tester answered): `evaluated`, one
//   result per rule in the request's order, matched by id (a missing, extra or
//   repeated id is no answer: `unavailable`); `busy` for 503 `evaluator_busy`,
//   so the dispatcher may try once more; every other failure `unavailable`,
//   with a reason (the run ends Error, `rules_unavailable`);
// - validate (one rule, at Save): `valid`, or `invalid` with the evaluator's
//   problems as it words them (Save shows them as they are); `busy`;
//   `unavailable`;
// - lint (the public API's OTTL lint): `linted`, one verdict per text in
//   the request's order (the conditions, then the statements, then the value
//   expressions), matched by kind and index (a missing, extra or misplaced
//   item is no answer: `unavailable`); `busy`; `unavailable`;
// - health: `up` or `down`, for the health monitor.
//
// The request is built from what the platform holds: the tester's output
// object as it answered it but for `bytesOnDisk` (`{base64, truncated}`, the
// contract's Output), the stored log, and each rule's kind, target and pattern
// or OTTL (a run's snapshot, or a save's). A condition or an expression that
// is empty is left out, never sent as `""`. A request the contract would
// refuse (a count that isn't an integer, a repeated id, more than 200 rules,
// …) is never sent: it is `unavailable`, `invalid_request`, since one bad rule
// would otherwise have the evaluator refuse every rule.
//
// The secret, the Authorization header, the output, the log and every rule's
// text are never logged and never put in a result. The only lines it logs
// (at error level, through the optional `log`) are for what a deployment
// must fix: a 401 (the evaluator doesn't take the secret), a 400 or 413 (the
// platform broke the contract), a 5xx other than busy, a status the
// contract doesn't give, a reply it can't read or that answers other rules,
// and a request it refused to send, with the reason, the status and the
// evaluator's error code from its envelope (the contract's fixed list),
// never the body.

/** A rule as the evaluator checks it: a run's snapshot of it, or what a save sends. */
export interface OttlEvaluatorRule {
  /** The rule's id: the platform's results are matched by it. */
  id: string;
  kind: ValidationRuleKind;
  target: ValidationRuleTarget;
  /** A text or regex rule's pattern; null or absent for an OTTL rule. */
  pattern?: string | null | undefined;
  /** An OTTL rule's OTTL; null or absent for the others. */
  ottl?: ValidationRuleOttl | null | undefined;
}

/** The tester's output, as its answer carries it (otelcol-testing/schemas.ts): its bytes, and whether it was cut at 10 MiB. */
export interface OttlEvaluatorOutput {
  /** The output's bytes (the tester's `base64`, decoded). */
  base64: Uint8Array;
  truncated: boolean;
}

/** What a run's rules are checked against (openapi.yaml's EvaluateRequest). */
export interface EvaluateRulesRequest {
  signal: TestRunSignal;
  /**
   * The tester's output object, or null when the collector wrote no record.
   * Its `bytesOnDisk`, if it carries one, isn't sent: the contract's Output
   * has `base64` and `truncated` only.
   */
  output: OttlEvaluatorOutput | null;
  /** The collector's log, as stored (at most 262,144 characters). Stderr rules search it. */
  log: string;
  /** 1 to 200 rules, each id once. */
  rules: readonly OttlEvaluatorRule[];
}

/** One rule to check at Save (openapi.yaml's ValidateRequest): its id isn't needed. */
export interface ValidateRuleRequest {
  signal: TestRunSignal;
  rule: Omit<OttlEvaluatorRule, "id">;
}

/** OTTL texts to parse-check against one context (openapi.yaml's LintRequest). */
export interface LintTextsRequest {
  context: OttlContext;
  conditions?: readonly string[] | undefined;
  statements?: readonly string[] | undefined;
  valueExpressions?: readonly string[] | undefined;
}

/** One text's verdict: its kind, its place in its own list, and the evaluator's words when it isn't valid. Never the text. */
export interface OttlLintVerdict {
  kind: OttlLintKind;
  index: number;
  valid: boolean;
  /** Null exactly when the text is valid. */
  error: string | null;
}

/** Why the evaluator gave no answer. */
export type OttlEvaluatorUnavailableReason =
  /** The caller's signal had ended the call before it was made: nothing was sent. */
  | "not_sent"
  /** The caller's signal ended the call after it was sent (the API stopping). */
  | "aborted"
  /** No answer within the call's timer, the reply's body included. */
  | "timeout"
  /** The connection was refused: nothing was sent. */
  | "connection_refused"
  /** The evaluator's name didn't resolve (ENOTFOUND, EAI_AGAIN): nothing was sent. */
  | "name_not_resolved"
  /** The request or its reply broke off otherwise. */
  | "network"
  /** 401: the evaluator doesn't take TELFLO_OTTL_EVALUATOR_SECRET. A deployment to fix; logged. */
  | "unauthorized"
  /** 400 from the evaluator, or a request the client wouldn't send: the platform broke the contract. Logged. */
  | "invalid_request"
  /** 413: the body is larger than the evaluator takes. Logged. */
  | "payload_too_large"
  /** 500, or any 5xx but busy: the evaluator couldn't answer. Logged. */
  | "server_error"
  /** A status the contract doesn't give (a redirect, 404, 405, a 2xx other than 200). Logged. */
  | "unexpected_status"
  /** A 200 whose body isn't what openapi.yaml documents, or answers other rules than those asked. Logged. */
  | "malformed_reply"
  /** A reply over the cap, never read past it. Logged. */
  | "oversized_reply";

export interface OttlEvaluatorUnavailable {
  kind: "unavailable";
  reason: OttlEvaluatorUnavailableReason;
  /** The evaluator's status, when it answered one. */
  status?: number;
  /** The code of its error envelope, when it had one. */
  code?: OttlEvaluatorErrorCode;
}

/** 503 `evaluator_busy`: every slot stayed taken. The dispatcher may try once more. */
export interface OttlEvaluatorBusy {
  kind: "busy";
}

export type EvaluateRulesResult =
  /** Each rule's result, in the request's order. */
  | { kind: "evaluated"; ottlVersion: string; results: OttlEvaluatorResult[] }
  | OttlEvaluatorBusy
  | OttlEvaluatorUnavailable;

export type ValidateRuleResult =
  | { kind: "valid" }
  /** The evaluator's problems, each worded as a run's rule error would be. */
  | { kind: "invalid"; problems: OttlEvaluatorProblem[] }
  | OttlEvaluatorBusy
  | OttlEvaluatorUnavailable;

export type LintTextsResult =
  /** Each text's verdict, in the request's order. */
  | { kind: "linted"; ottlVersion: string; items: OttlLintVerdict[] }
  | OttlEvaluatorBusy
  | OttlEvaluatorUnavailable;

export type OttlEvaluatorHealthResult =
  | { kind: "up"; ottlVersion: string }
  | {
      kind: "down";
      reason: "timeout" | "network" | "connection_refused" | "name_not_resolved" | "http_status" | "malformed_reply";
      status?: number;
    };

export interface OttlEvaluatorClient {
  /** Checks a run's rules against its output and log. Never throws for anything the evaluator does or doesn't answer. */
  evaluate(request: EvaluateRulesRequest, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<EvaluateRulesResult>;
  /** Checks one rule as a run would, at Save. Never throws for anything the evaluator does or doesn't answer. */
  validate(request: ValidateRuleRequest, options?: { signal?: AbortSignal }): Promise<ValidateRuleResult>;
  /** Parse-checks up to 200 OTTL texts against one context. Never throws for anything the evaluator does or doesn't answer. */
  lint(request: LintTextsRequest, options?: { signal?: AbortSignal }): Promise<LintTextsResult>;
  /** Asks GET /health (no secret). Never throws. */
  health(options?: { signal?: AbortSignal }): Promise<OttlEvaluatorHealthResult>;
}

/** Where the client logs what a deployment must fix. A pino/Fastify logger fits. */
export interface OttlEvaluatorClientLog {
  error(details: Record<string, unknown>, message: string): void;
}

export interface OttlEvaluatorClientOptions {
  /** The evaluator's base URL, e.g. `http://ottl-evaluator:8003`. A trailing slash is dropped; a user name or password is refused. */
  url: string;
  /** The shared secret. Never logged. */
  secret: string;
  /** Tests only; the global fetch by default. */
  fetch?: typeof fetch;
  /** Tests only; MAX_OTTL_EVALUATOR_REPLY_BYTES by default. */
  maxReplyBytes?: number;
  /** Where what a deployment must fix is logged. Nothing is logged without it. */
  log?: OttlEvaluatorClientLog;
}

/**
 * An evaluation's one timer: the evaluator's own hard limit (its child is
 * killed at 25 s, after a 20 s deadline), the 5 s it may wait for a slot,
 * and room to carry up to 36 MiB both ways. A caller may shorten it (the
 * dispatcher's lease left, less 5 s), never lengthen it.
 */
export const OTTL_EVALUATOR_EVALUATE_TIMEOUT_MS = 40_000;

/** A save's check: the evaluator kills a validation at 2 s, after waiting up to 1 s for a slot. */
export const OTTL_EVALUATOR_VALIDATE_TIMEOUT_MS = 5_000;

/**
 * A lint's timer: the evaluator kills a lint at 10 s, after waiting up to 1 s
 * for a slot, and its body is at most 10 MiB.
 */
export const OTTL_EVALUATOR_LINT_TIMEOUT_MS = 15_000;

/** A health check's timer, as the tester's: the monitor waits its 5 s after each check ends. */
export const OTTL_EVALUATOR_HEALTH_TIMEOUT_MS = 5_000;

/**
 * The most of an evaluation's answer the client reads: 6 MiB. 200 results at
 * their bounds, each message 4 KiB and five matches of 200 + 40 + 40 bytes
 * with a 200-byte path, are about 4.9 MiB once JSON escapes control
 * characters.
 */
export const MAX_OTTL_EVALUATOR_REPLY_BYTES = 6 * 1024 * 1024;

/** A validation's answer: a few problems of at most 4 KiB each. */
const MAX_VALIDATE_REPLY_BYTES = 1024 * 1024;

/** A lint's answer: 200 items, each with a message of at most 4 KiB, escaped. */
export const MAX_OTTL_EVALUATOR_LINT_REPLY_BYTES = 6 * 1024 * 1024;

/** A health reply or an error envelope is a few bytes; this bounds a stranger's. */
const MAX_SMALL_REPLY_BYTES = 64 * 1024;

/** The output's most bytes, decoded (openapi.yaml's Output): the tester's 10 MiB. */
const MAX_OUTPUT_BYTES = 10_485_760;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The socket errors after which nothing was sent, and the reason each gives. */
const NOTHING_SENT_CODES: Readonly<Record<string, "connection_refused" | "name_not_resolved">> = {
  ECONNREFUSED: "connection_refused",
  ENOTFOUND: "name_not_resolved",
  EAI_AGAIN: "name_not_resolved",
};

/** Why fetch failed before anything was sent, if it did: undici puts the socket's or the resolver's error in `cause`. */
function nothingSentReason(error: unknown): "connection_refused" | "name_not_resolved" | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && Object.hasOwn(NOTHING_SENT_CODES, code)) return NOTHING_SENT_CODES[code];
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Joins `signal` (the caller's) to `controller` (the timer's). */
function follow(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  const onAbort = (): void => controller.abort();
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** The reasons logged at error level: each is a deployment's (or the platform's) to fix. */
const LOGGED_REASONS: ReadonlySet<OttlEvaluatorUnavailableReason> = new Set<OttlEvaluatorUnavailableReason>([
  "unauthorized",
  "invalid_request",
  "payload_too_large",
  "server_error",
  "unexpected_status",
  "malformed_reply",
  "oversized_reply",
]);

/** The statuses whose reason the status alone gives (openapi.yaml). */
const STATUS_REASONS: Readonly<Record<number, OttlEvaluatorUnavailableReason>> = {
  400: "invalid_request",
  401: "unauthorized",
  413: "payload_too_large",
};

/*
 * The request the contract takes (openapi.yaml's EvaluateRequest and
 * ValidateRequest), checked before anything is sent. Lengths count code
 * points, as JSON Schema's maxLength does; a pattern, condition or
 * expression between 8,192 characters and 8,192 bytes is the evaluator's
 * rule error, not a refused request.
 */

const codePoints = (text: string): number => [...text].length;
const boundedString = (minimum: number, maximum: number) =>
  z.string().refine((text) => {
    const length = codePoints(text);
    return length >= minimum && length <= maximum;
  });
const countValue = z.number().int().min(0).max(2_147_483_647);
const requestOttl = z
  .object({
    context: z.enum(["log", "span", "spanevent", "metric", "datapoint", "resource", "scope"]),
    quantifier: z.enum(["all", "any", "none", "count", "distinct"]),
    condition: boundedString(0, 8_192).optional(),
    expression: boundedString(0, 8_192).optional(),
    count: z
      .object({
        operator: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "between"]),
        value: countValue,
        value2: countValue.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const requestTextRule = z
  .object({
    kind: z.enum(["contains_text", "not_contains_text", "contains_regex", "not_contains_regex"]),
    target: z.enum(["output", "stderr"]),
    pattern: boundedString(1, 8_192),
  })
  .strict();
const requestOttlRule = z.object({ kind: z.literal("ottl"), target: z.literal("output"), ottl: requestOttl }).strict();
const requestRule = z.union([requestTextRule, requestOttlRule]);
const ruleId = z.string().min(1).max(128);
const evaluateRequestSchema = z
  .object({
    signal: z.enum(["logs", "traces", "metrics"]),
    output: z.object({ base64: z.string(), truncated: z.boolean() }).strict().nullable(),
    log: boundedString(0, 262_144),
    rules: z
      .array(z.union([requestTextRule.extend({ id: ruleId }).strict(), requestOttlRule.extend({ id: ruleId }).strict()]))
      .min(1)
      .max(200)
      .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, "each id once"),
  })
  .strict();
const validateRequestSchema = z.object({ signal: z.enum(["logs", "traces", "metrics"]), rule: requestRule }).strict();
const lintTexts = z.array(boundedString(0, 8_192)).max(200);
const lintRequestSchema = z
  .object({
    context: z.enum(["log", "span", "spanevent", "metric", "datapoint", "resource", "scope"]),
    conditions: lintTexts.optional(),
    statements: lintTexts.optional(),
    valueExpressions: lintTexts.optional(),
  })
  .strict()
  .refine((body) => {
    const total = (body.conditions?.length ?? 0) + (body.statements?.length ?? 0) + (body.valueExpressions?.length ?? 0);
    return total >= 1 && total <= 200;
  }, "1 to 200 texts in all");

/**
 * The rule as the contract takes it: a text or regex rule's pattern, or an
 * OTTL rule's OTTL with an empty condition or expression left out (never
 * `""`). A field a kind doesn't take is left out, so the request check
 * refuses a rule whose kind and fields disagree.
 */
function contractRule(rule: Omit<OttlEvaluatorRule, "id">): Record<string, unknown> {
  if (rule.kind !== "ottl") {
    return {
      kind: rule.kind,
      target: rule.target,
      ...(rule.pattern === undefined || rule.pattern === null ? {} : { pattern: rule.pattern }),
      ...(rule.ottl === undefined || rule.ottl === null ? {} : { ottl: rule.ottl }),
    };
  }
  const ottl = rule.ottl;
  const sent: Record<string, unknown> | undefined =
    ottl === undefined || ottl === null
      ? undefined
      : {
          context: ottl.context,
          quantifier: ottl.quantifier,
          ...(ottl.condition === undefined || ottl.condition === "" ? {} : { condition: ottl.condition }),
          ...(ottl.expression === undefined || ottl.expression === "" ? {} : { expression: ottl.expression }),
          ...(ottl.count === undefined ? {} : { count: ottl.count }),
        };
  return {
    kind: rule.kind,
    target: rule.target,
    ...(sent === undefined ? {} : { ottl: sent }),
    ...(rule.pattern === undefined || rule.pattern === null ? {} : { pattern: rule.pattern }),
  };
}

/** The evaluate request's body, or undefined when the contract wouldn't take it. */
function evaluateBody(request: EvaluateRulesRequest): string | undefined {
  if (request.output !== null && request.output.base64.byteLength > MAX_OUTPUT_BYTES) return undefined;
  const body = {
    signal: request.signal,
    output:
      request.output === null
        ? null
        : {
            base64: Buffer.from(request.output.base64.buffer, request.output.base64.byteOffset, request.output.base64.byteLength).toString(
              "base64",
            ),
            truncated: request.output.truncated,
          },
    log: request.log,
    rules: request.rules.map((rule) => ({ id: rule.id, ...contractRule(rule) })),
  };
  return evaluateRequestSchema.safeParse(body).success ? JSON.stringify(body) : undefined;
}

/** The validate request's body, or undefined when the contract wouldn't take it. */
function validateBody(request: ValidateRuleRequest): string | undefined {
  const body = { signal: request.signal, rule: contractRule(request.rule) };
  return validateRequestSchema.safeParse(body).success ? JSON.stringify(body) : undefined;
}

/** The lint request's body (an empty list left out), or undefined when the contract wouldn't take it. */
function lintBody(request: LintTextsRequest): string | undefined {
  const lists = { conditions: request.conditions, statements: request.statements, valueExpressions: request.valueExpressions };
  const body: Record<string, unknown> = { context: request.context };
  for (const [name, texts] of Object.entries(lists)) if (texts !== undefined && texts.length > 0) body[name] = [...texts];
  return lintRequestSchema.safeParse(body).success ? JSON.stringify(body) : undefined;
}

/** The kind and index of each text the lint asks about, in the answer's order. */
function lintTargets(request: LintTextsRequest): Array<{ kind: OttlLintKind; index: number }> {
  return [
    ...(request.conditions ?? []).map((_, index) => ({ kind: "condition" as const, index })),
    ...(request.statements ?? []).map((_, index) => ({ kind: "statement" as const, index })),
    ...(request.valueExpressions ?? []).map((_, index) => ({ kind: "valueExpression" as const, index })),
  ];
}

export function createOttlEvaluatorClient(options: OttlEvaluatorClientOptions): OttlEvaluatorClient {
  let parsedUrl: URL | undefined;
  try {
    parsedUrl = new URL(options.url);
  } catch {
    // Settings refuse it at boot; a client built on one anyway answers every call unavailable, never throws.
    parsedUrl = undefined;
  }
  if (parsedUrl !== undefined && (parsedUrl.username !== "" || parsedUrl.password !== "")) {
    // fetch refuses such a URL, and the credentials would sit where errors treat them as harmless.
    throw new RangeError("The OTTL evaluator's URL must not carry a user name or password.");
  }
  const base = options.url.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const maxReplyBytes = options.maxReplyBytes ?? MAX_OTTL_EVALUATOR_REPLY_BYTES;
  const log = options.log;

  function unavailable(
    operation: "evaluate" | "validate" | "lint",
    reason: OttlEvaluatorUnavailableReason,
    details: { status?: number; code?: OttlEvaluatorErrorCode } = {},
  ): OttlEvaluatorUnavailable {
    if (LOGGED_REASONS.has(reason)) {
      // The status and the envelope's code (the contract's fixed list), never the body.
      log?.error(
        {
          operation,
          reason,
          ...(details.status === undefined ? {} : { status: details.status }),
          ...(details.code === undefined ? {} : { code: details.code }),
        },
        "the OTTL evaluator's answer can't be used: check TELFLO_OTTL_EVALUATOR_URL and _SECRET, and the evaluator's version",
      );
    }
    return { kind: "unavailable", reason, ...details };
  }

  /**
   * POSTs `body` to `path` under one timer of `timeoutMs`, and hands a 200's
   * parsed body to `answer`; every other outcome is busy or unavailable.
   */
  async function post<T>(
    operation: "evaluate" | "validate" | "lint",
    path: string,
    body: string,
    timeoutMs: number,
    replyCap: number,
    signal: AbortSignal | undefined,
    answer: (parsed: unknown) => T | OttlEvaluatorUnavailable,
  ): Promise<T | OttlEvaluatorBusy | OttlEvaluatorUnavailable> {
    // Stopped before it was made: nothing is sent.
    if (signal?.aborted) return unavailable(operation, "not_sent");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const unfollow = follow(signal, controller);
    // A failed fetch or read. Its error's own text is dropped: it can quote the request.
    const brokeOff = (error: unknown): OttlEvaluatorUnavailable => {
      if (signal?.aborted) return unavailable(operation, "aborted");
      if (controller.signal.aborted) return unavailable(operation, "timeout");
      return unavailable(operation, nothingSentReason(error) ?? "network");
    };
    try {
      let response: Response;
      try {
        response = await doFetch(`${base}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.secret}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body,
          // The contract never answers one, and following it would send the secret on.
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        return brokeOff(error);
      }
      const { status } = response;

      let text: string | typeof TOO_LARGE;
      try {
        text = await readCapped(response, status === 200 ? replyCap : MAX_SMALL_REPLY_BYTES);
      } catch (error) {
        if (status !== 200) {
          // A failure's body is read only for its code; losing it loses only that.
          if (signal?.aborted || controller.signal.aborted) return brokeOff(error);
          text = "";
        } else {
          return brokeOff(error);
        }
      }

      if (status !== 200) {
        const envelope = errorEnvelopeSchema.safeParse(text === TOO_LARGE ? undefined : parseJson(text));
        const code = envelope.success ? envelope.data.error.code : undefined;
        const details = code === undefined ? { status } : { status, code };
        if (status === 503 && code === "evaluator_busy") return { kind: "busy" };
        const reason = STATUS_REASONS[status] ?? (status >= 500 ? "server_error" : "unexpected_status");
        return unavailable(operation, reason, details);
      }
      if (text === TOO_LARGE) return unavailable(operation, "oversized_reply", { status });
      return answer(parseJson(text));
    } finally {
      clearTimeout(timer);
      unfollow();
    }
  }

  return {
    async evaluate(request, evaluateOptions = {}) {
      const body = evaluateBody(request);
      if (body === undefined) return unavailable("evaluate", "invalid_request");
      const timeoutMs = Math.min(evaluateOptions.timeoutMs ?? OTTL_EVALUATOR_EVALUATE_TIMEOUT_MS, OTTL_EVALUATOR_EVALUATE_TIMEOUT_MS);
      return post("evaluate", "/ottl/v1/evaluate", body, timeoutMs, maxReplyBytes, evaluateOptions.signal, (parsed) => {
        const answer = evaluateAnswerSchema.safeParse(parsed);
        if (!answer.success) return unavailable("evaluate", "malformed_reply", { status: 200 });
        // Matched by id (detail 27): every rule asked, once, and no other.
        const asked = new Set(request.rules.map((rule) => rule.id));
        const byId = new Map<string, OttlEvaluatorResult>();
        for (const result of answer.data.results) {
          if (!asked.has(result.id) || byId.has(result.id)) return unavailable("evaluate", "malformed_reply", { status: 200 });
          byId.set(result.id, result);
        }
        if (byId.size !== asked.size) return unavailable("evaluate", "malformed_reply", { status: 200 });
        return {
          kind: "evaluated" as const,
          ottlVersion: answer.data.ottlVersion,
          results: request.rules.map((rule) => byId.get(rule.id)!),
        };
      });
    },

    async validate(request, validateOptions = {}) {
      const body = validateBody(request);
      if (body === undefined) return unavailable("validate", "invalid_request");
      return post(
        "validate",
        "/ottl/v1/validate",
        body,
        OTTL_EVALUATOR_VALIDATE_TIMEOUT_MS,
        Math.min(maxReplyBytes, MAX_VALIDATE_REPLY_BYTES),
        validateOptions.signal,
        (parsed): ValidateRuleResult => {
          const answer = validateAnswerSchema.safeParse(parsed);
          if (!answer.success) return unavailable("validate", "malformed_reply", { status: 200 });
          return answer.data.valid ? { kind: "valid" } : { kind: "invalid", problems: answer.data.problems! };
        },
      );
    },

    async lint(request, lintOptions = {}) {
      const body = lintBody(request);
      if (body === undefined) return unavailable("lint", "invalid_request");
      const targets = lintTargets(request);
      return post(
        "lint",
        "/ottl/v1/lint",
        body,
        OTTL_EVALUATOR_LINT_TIMEOUT_MS,
        Math.min(maxReplyBytes, MAX_OTTL_EVALUATOR_LINT_REPLY_BYTES),
        lintOptions.signal,
        (parsed): LintTextsResult => {
          const answer = lintAnswerSchema.safeParse(parsed);
          if (!answer.success) return unavailable("lint", "malformed_reply", { status: 200 });
          // Every text asked, in order, once (by kind and index), and no other.
          const { items } = answer.data;
          if (items.length !== targets.length || items.some((item, at) => item.kind !== targets[at]!.kind || item.index !== targets[at]!.index)) {
            return unavailable("lint", "malformed_reply", { status: 200 });
          }
          return {
            kind: "linted",
            ottlVersion: answer.data.ottlVersion,
            items: items.map(({ kind, index, valid, error }) => ({ kind, index, valid, error: error ?? null })),
          };
        },
      );
    },

    async health(healthOptions = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OTTL_EVALUATOR_HEALTH_TIMEOUT_MS);
      const unfollow = follow(healthOptions.signal, controller);
      const brokeOff = (error: unknown): OttlEvaluatorHealthResult => {
        if (controller.signal.aborted && !healthOptions.signal?.aborted) return { kind: "down", reason: "timeout" };
        if (controller.signal.aborted) return { kind: "down", reason: "network" };
        return { kind: "down", reason: nothingSentReason(error) ?? "network" };
      };
      try {
        let response: Response;
        try {
          // No secret: the route takes none, and it needn't travel.
          response = await doFetch(`${base}/health`, {
            method: "GET",
            headers: { accept: "application/json" },
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          return brokeOff(error);
        }
        const { status } = response;
        if (status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return { kind: "down", reason: "http_status", status };
        }
        let text: string | typeof TOO_LARGE;
        try {
          text = await readCapped(response, MAX_SMALL_REPLY_BYTES);
        } catch (error) {
          return brokeOff(error);
        }
        const parsed = healthSchema.safeParse(text === TOO_LARGE ? undefined : parseJson(text));
        return parsed.success ? { kind: "up", ottlVersion: parsed.data.ottlVersion } : { kind: "down", reason: "malformed_reply", status };
      } finally {
        clearTimeout(timer);
        unfollow();
      }
    },
  };
}
