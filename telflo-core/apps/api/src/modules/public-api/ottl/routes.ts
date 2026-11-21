import { ErrorResponseSchema, PublicOttlLintRequestSchema, PublicOttlLintResponseSchema } from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createOttlLintService } from "../../ottl-lint/service.js";
import { apiActorOf } from "../actor.js";
import type { PublicApiArea } from "../area.js";

/*
 * The public surface's OTTL lint, registered into the `/api/public/v1`
 * plugin (routes.ts), so it runs the token check, the per-token limit and
 * its access check (read) before anything else. A YAML's every OTTL
 * expression, or expressions against one context, parse-checked by the OTTL
 * evaluator (modules/ottl-lint/), as the token's user in its organization:
 * the person's `ottlLintsPerUser`. The service is built once, here, as the
 * plugin registers once per server; it has no browser route to share it
 * with, and its limiter is the server's one. Its OpenAPI fragment is
 * `openapi/ottl.yaml`.
 *
 * The YAML and the expressions (each item's `input` echoes the caller's
 * own) go only into the reply's body, never a log line or an error's
 * message; the reply is `no-store`.
 */

/**
 * The body limit, the gateway's on the same path. A YAML of 262,144
 * characters fits it however JSON escapes it (at most 1.5 MiB). 200
 * expressions of 8,192 characters (1.6 million characters) may not: the
 * contract takes them, but a body over 2 MiB as sent answers 413
 * `payload_too_large` first, so the 2 MiB is the effective bound on the
 * expressions (the contract and the OpenAPI document say so).
 */
export const OTTL_LINT_BODY_LIMIT = 2 * 1024 * 1024;

export const registerOttlPublicRoutes: PublicApiArea = (api, { deps, rateLimiters }) => {
  const typed = api.withTypeProvider<ZodTypeProvider>();
  const lint = createOttlLintService({ evaluator: deps.testing.ottlEvaluator, limiter: rateLimiters.ottlLintsPerUser, log: api.log });

  typed.post(
    "/ottl/lint",
    {
      config: { access: "read" },
      bodyLimit: OTTL_LINT_BODY_LIMIT,
      schema: {
        body: PublicOttlLintRequestSchema,
        response: {
          200: PublicOttlLintResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          413: ErrorResponseSchema,
          422: ErrorResponseSchema,
          429: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const organizationId = actor.context.organizationId;
      const body = request.body;
      const answer =
        body.yaml !== undefined
          ? await lint.lintConfiguration(actor, organizationId, body.yaml)
          : await lint.lintExpressions(actor, organizationId, {
              // The contract requires a context when there is no yaml.
              context: body.context!,
              conditions: body.conditions,
              statements: body.statements,
              valueExpressions: body.valueExpressions,
            });
      return reply.header("cache-control", "no-store").send(answer);
    },
  );
};
