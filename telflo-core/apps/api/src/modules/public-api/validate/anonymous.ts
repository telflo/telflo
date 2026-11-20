import { ErrorResponseSchema, PublicValidateRequestSchema, PublicValidateResponseSchema } from "@telflo/contracts";
import type { FastifyInstance, onSendHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { notFoundWhen } from "../../../http/not-found-when.js";
import type { AnonymousValidationLimiter } from "../../../http/rate-limits.js";
import type { IValidationService } from "../../configurations/validation.js";

/*
 * The public surface's anonymous validate:
 * `POST /api/public/v1/validate/anonymous`, an open route (open-routes.ts,
 * on route-guard.ts' OPEN_PUBLIC_ROUTES as POST only), so no token, no
 * organization and no per-token count. An `Authorization` header sent is
 * never read: no token check runs, so a bearer is neither looked up nor
 * counted against the address's token failures.
 *
 * The body is `/validate`'s (`PublicValidateRequestSchema`, strict), the
 * answer too, `no-store` (every reply of this route, its refusals
 * included). Once the body passed its checks, the anonymous limits admit
 * it (per address and overall, a minute's count and slots in flight: 429
 * `rate_limited` with Retry-After), before the catalog's reads; then the
 * validation service's `validateAnonymousText` (no organization variables;
 * the same 400s as `/validate`, and 503 `validation_unavailable`).
 *
 * Its record is the request log's line only (method, the route's path,
 * status): the text and the validator's errors go only into the reply,
 * never a log line, an error's message or a span. No audit row. Its OpenAPI
 * operation is `openapi/validate.yaml`'s.
 *
 * Switched: with TELFLO_ANONYMOUS_VALIDATE off, the open source's default,
 * it answers as a path nothing serves (404 `not_found`), before the body's
 * limit and the anonymous limits count it. It stays registered, and on the
 * open surface's allowlist: unregistered, its path would answer the public
 * plugin's 401 instead.
 */

/** The path under the prefix. */
export const ANONYMOUS_VALIDATE_PATH = "/validate/anonymous";

/**
 * The body limit: 1 MiB, the gateway's catch-all for public paths (its 2
 * MiB location's regex ends at `validate$`). Past it, 413
 * `payload_too_large` in the envelope, before the limits count it.
 */
export const ANONYMOUS_VALIDATE_BODY_LIMIT = 1024 * 1024;

export interface AnonymousValidateDependencies {
  /** The site's TELFLO_ANONYMOUS_VALIDATE (settings.site.anonymousValidate): false answers 404. */
  anonymousValidate: boolean;
  validation: Pick<IValidationService, "validateAnonymousText">;
  /** The anonymous validations' two-level limiter (RateLimiters' anonymousValidations). */
  anonymousValidationLimiter: AnonymousValidationLimiter;
}

/** Every reply of the route is kept by no cache: the answer, and the 400s, 413, 429 and 503 the root's error handler sends. */
const noStore: onSendHookHandler = async (_request, reply, payload) => {
  void reply.header("cache-control", "no-store");
  return payload;
};

export function registerAnonymousValidateRoute(
  open: FastifyInstance,
  { anonymousValidate, validation, anonymousValidationLimiter }: AnonymousValidateDependencies,
): void {
  const typed = open.withTypeProvider<ZodTypeProvider>();
  typed.post(
    ANONYMOUS_VALIDATE_PATH,
    {
      bodyLimit: ANONYMOUS_VALIDATE_BODY_LIMIT,
      // First: off, nothing else runs, not even the body's limit.
      onRequest: notFoundWhen(!anonymousValidate),
      onSend: noStore,
      schema: {
        body: PublicValidateRequestSchema,
        response: {
          200: PublicValidateResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          413: ErrorResponseSchema,
          429: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Counted before the catalog's reads; the slots are held until the answer.
      const admission = anonymousValidationLimiter.admit(request.ip);
      try {
        const answer = await validation.validateAnonymousText(request.body);
        return reply.send(answer);
      } finally {
        admission.release();
      }
    },
  );
}
