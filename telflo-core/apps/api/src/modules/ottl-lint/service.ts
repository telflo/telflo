import { PUBLIC_OTTL_LINT_EXPRESSION_MAXIMUM_LENGTH, type OttlContext, type PublicOttlLintItem, type PublicOttlLintResponse } from "@telflo/contracts";
import type { FastifyBaseLogger } from "fastify";
import { parseDocument } from "yaml";
import { rateLimited, type PerUserLimiter } from "../../http/rate-limits.js";
import type { LintTextsRequest, OttlEvaluatorClient, OttlLintVerdict } from "../../ottl-evaluator/client.js";
import { assertActiveOrganization, type Actor } from "../organizations/service.js";
import { configurationInvalid } from "../public-api/shared-errors.js";
import { downgradeCustomFunction } from "./custom-functions.js";
import { ottlLintUnavailable, tooManyExpressions } from "./errors.js";
import { extractOttl, type ExtractedExpression } from "./extraction.js";

/*
 * The public API's OTTL lint, on the platform's evaluator
 * (`POST /ottl/v1/lint`):
 *
 * - expressions: up to 200 conditions, statements and value expressions
 *   against one context, as the request sends them;
 * - a configuration: every OTTL expression in a collector configuration
 *   (extraction.ts), each context's batch linted in turn, each verdict
 *   mapped back to its YAML location, a transform-only function's
 *   "undefined function" turned into a note (custom-functions.ts), and the
 *   verdicts in the YAML's order. An expression the YAML holds over 8,192
 *   characters (which the request's contract can't refuse, as it refuses
 *   one sent as such) is answered here, in the evaluator's own words for
 *   it, and only the rest is sent.
 *
 * The single-escaped regex check is the evaluator's (its guards run before
 * each parse), so it isn't here. Each lint that calls the evaluator spends
 * one of the person's `ottlLintsPerUser` in the organization (30 a minute),
 * and holds one of their OTTL_LINTS_IN_FLIGHT_PER_USER places there until
 * it ends (so one person can't hold the evaluator's shared slots), the
 * generic 429 past either; a lint that calls nothing spends nothing. An
 * evaluator that can't answer (down, busy, refusing the secret, a malformed
 * answer) is 503 `ottl_lint_unavailable`, never a verdict. An item's
 * `input` is the caller's own expression, from the request (the evaluator
 * echoes none). Nothing is stored or audited, and the YAML, the expressions
 * and the evaluator's words never reach a log line: the log holds the
 * organization's id, the mode, counts and the result.
 */

export interface OttlLintServiceDependencies {
  evaluator: OttlEvaluatorClient;
  limiter: PerUserLimiter;
  log: Pick<FastifyBaseLogger, "info" | "warn">;
}

/** Expressions against one context, as the request sends them. */
export interface OttlLintExpressions {
  context: OttlContext;
  conditions?: readonly string[] | undefined;
  statements?: readonly string[] | undefined;
  valueExpressions?: readonly string[] | undefined;
}

export interface IOttlLintService {
  /** Lints the expressions against their context. 429 `rate_limited`; 503 `ottl_lint_unavailable`. */
  lintExpressions(actor: Actor, organizationId: string, input: OttlLintExpressions): Promise<PublicOttlLintResponse>;
  /**
   * Lints every OTTL expression in a collector configuration's text. 422
   * `configuration_invalid` for a text that doesn't parse or isn't a
   * mapping; 400 `invalid_request` for more than 200 expressions; 429; 503.
   */
  lintConfiguration(actor: Actor, organizationId: string, yaml: string): Promise<PublicOttlLintResponse>;
}

/**
 * How many of a person's lints in one organization may wait on the evaluator
 * at once, as their validations (VALIDATIONS_IN_FLIGHT_PER_USER): lints share
 * the evaluator's 8 validation slots. Not a test override: every server has
 * the real number.
 */
export const OTTL_LINTS_IN_FLIGHT_PER_USER = 2;

/** An in-flight refusal's Retry-After: a lint ends within the client's 15 s, usually far sooner. */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

/** The most expressions one lint checks: the evaluator's cap. */
const MAXIMUM_EXPRESSIONS = 200;

/** As the flows' lint reads a configuration (flows/lint.ts): the core schema, merge keys, unique keys, no warning passed on. */
const PARSE_OPTIONS = { merge: true, prettyErrors: false, uniqueKeys: true, logLevel: "error" } as const;

/** How many aliases one text may resolve before it is refused as an alias bomb (`yaml`'s default, the flows' too). */
const MAXIMUM_ALIAS_COUNT = 100;

/** The text as the `yaml` package reads it, its mappings as Maps (the text's order), or undefined when it doesn't parse. */
function parseConfiguration(text: string): { config: unknown } | undefined {
  try {
    const document = parseDocument(text, PARSE_OPTIONS);
    if (document.errors.length > 0) return undefined;
    return { config: document.toJS({ mapAsMap: true, maxAliasCount: MAXIMUM_ALIAS_COUNT }) };
  } catch {
    return undefined;
  }
}

/** Code points, as the evaluator's contract counts a text's length. */
const codePoints = (text: string): number => [...text].length;

/**
 * The evaluator's own words for a text over its bytes (internal/rules'
 * textProblem: "The condition is longer than 8,192 bytes."): a text over
 * 8,192 characters is over 8,192 bytes too.
 */
const tooLongMessage = (kind: ExtractedExpression["kind"]) => `The ${kind} is longer than 8,192 bytes.`;

export function createOttlLintService(deps: OttlLintServiceDependencies): IOttlLintService {
  const { evaluator, limiter, log } = deps;
  /** Each person's lints waiting on the evaluator, per organization. */
  const inFlight = new Map<string, number>();

  /**
   * Admits one of the person's lints in the organization, or throws the
   * 429: their in-flight places first (a refusal there counts nothing), then
   * the minute's count. Returns the release of the place.
   */
  function admit(actor: Actor, organizationId: string): () => void {
    const key = `organization:${organizationId}:user:${actor.context.userId}`;
    const held = inFlight.get(key) ?? 0;
    if (held >= OTTL_LINTS_IN_FLIGHT_PER_USER) throw rateLimited(IN_FLIGHT_RETRY_AFTER_SECONDS);
    const admission = limiter.admit(actor.context.userId, organizationId);
    if (!admission.isAdmitted) throw rateLimited(admission.retryAfterSeconds);
    inFlight.set(key, held + 1);
    let isReleased = false;
    return () => {
      if (isReleased) return;
      isReleased = true;
      const remaining = (inFlight.get(key) ?? 1) - 1;
      if (remaining <= 0) inFlight.delete(key);
      else inFlight.set(key, remaining);
    };
  }

  /** The evaluator's verdicts, or the 503 (logged with the client's reason, never a text). */
  async function lint(request: LintTextsRequest, ids: Record<string, unknown>): Promise<{ ottlVersion: string; items: OttlLintVerdict[] }> {
    const result = await evaluator.lint(request);
    if (result.kind === "linted") return result;
    log.warn(
      {
        ...ids,
        result: "unavailable",
        reason: result.kind === "busy" ? "busy" : result.reason,
        ...(result.kind === "unavailable" && result.status !== undefined ? { status: result.status } : {}),
      },
      "the OTTL evaluator couldn't lint",
    );
    throw ottlLintUnavailable();
  }

  function answer(items: PublicOttlLintItem[], ottlVersion: string | null, skipped: string[]): PublicOttlLintResponse {
    return { valid: items.every((item) => item.valid), ottlVersion, checked: items.length, items, skipped };
  }

  return {
    async lintExpressions(actor, organizationId, input) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId, mode: "expressions" };
      const sent: Record<string, readonly string[]> = {
        condition: input.conditions ?? [],
        statement: input.statements ?? [],
        valueExpression: input.valueExpressions ?? [],
      };
      const release = admit(actor, organizationId);
      let linted: { ottlVersion: string; items: OttlLintVerdict[] };
      try {
        linted = await lint(
          { context: input.context, conditions: sent.condition, statements: sent.statement, valueExpressions: sent.valueExpression },
          ids,
        );
      } finally {
        release();
      }
      const items = linted.items.map(
        (verdict): PublicOttlLintItem => ({
          kind: verdict.kind,
          index: verdict.index,
          // The caller's own expression, from the request: the evaluator echoes none.
          input: sent[verdict.kind]![verdict.index]!,
          valid: verdict.valid,
          error: verdict.error,
          context: input.context,
          location: null,
          note: null,
        }),
      );
      const reply = answer(items, linted.ottlVersion, []);
      log.info({ ...ids, checked: reply.checked, result: reply.valid ? "valid" : "invalid" }, "OTTL linted");
      return reply;
    },

    async lintConfiguration(actor, organizationId, yaml) {
      assertActiveOrganization(actor, organizationId);
      const ids = { organizationId, mode: "configuration" };
      const parsed = parseConfiguration(yaml);
      if (parsed === undefined) throw configurationInvalid([{ message: "The YAML doesn't parse.", componentPath: null }]);
      if (!(parsed.config instanceof Map)) {
        throw configurationInvalid([{ message: "The YAML must be a collector configuration (a mapping).", componentPath: null }]);
      }

      const extraction = extractOttl(parsed.config);
      if (extraction.items.length > MAXIMUM_EXPRESSIONS) throw tooManyExpressions();

      /** Each expression's verdict, by its place in the YAML. */
      const results: Array<{ item: PublicOttlLintItem; order: number }> = [];
      const verdictOf = (expression: ExtractedExpression, order: number, verdict: Pick<PublicOttlLintItem, "valid" | "error">) =>
        results.push({
          order,
          item: downgradeCustomFunction<PublicOttlLintItem>({
            kind: expression.kind,
            index: 0,
            input: expression.input,
            valid: verdict.valid,
            error: verdict.error,
            context: expression.context,
            location: expression.location,
            note: expression.inferredContext
              ? `context inferred as '${expression.context}' (flat transform statement); a path error here may be a false positive`
              : null,
          }),
        });

      // Each context's batch to send, in the order its first expression
      // comes; one over the evaluator's length is answered here, as it would.
      const byContext = new Map<OttlContext, Array<{ expression: ExtractedExpression; order: number }>>();
      extraction.items.forEach((expression, order) => {
        if (codePoints(expression.input) > PUBLIC_OTTL_LINT_EXPRESSION_MAXIMUM_LENGTH) {
          verdictOf(expression, order, { valid: false, error: tooLongMessage(expression.kind) });
          return;
        }
        const batch = byContext.get(expression.context) ?? [];
        batch.push({ expression, order });
        byContext.set(expression.context, batch);
      });

      let ottlVersion: string | null = null;
      if (byContext.size > 0) {
        const release = admit(actor, organizationId);
        try {
          for (const [context, batch] of byContext) {
            const conditions = batch.filter(({ expression }) => expression.kind === "condition");
            const statements = batch.filter(({ expression }) => expression.kind === "statement");
            const linted = await lint(
              {
                context,
                conditions: conditions.map(({ expression }) => expression.input),
                statements: statements.map(({ expression }) => expression.input),
              },
              ids,
            );
            ottlVersion = linted.ottlVersion;
            for (const verdict of linted.items) {
              const source = (verdict.kind === "condition" ? conditions : statements)[verdict.index]!;
              verdictOf(source.expression, source.order, verdict);
            }
          }
        } finally {
          release();
        }
      }

      // The YAML's order, and the index counting across it.
      results.sort((first, second) => first.order - second.order);
      const items = results.map(({ item }, index) => ({ ...item, index }));
      const reply = answer(items, ottlVersion, extraction.skipped);
      log.info({ ...ids, checked: reply.checked, skipped: reply.skipped.length, result: reply.valid ? "valid" : "invalid" }, "OTTL linted");
      return reply;
    },
  };
}
