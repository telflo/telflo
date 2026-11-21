import { ErrorResponseSchema, PublicValidateRequestSchema, PublicValidateResponseSchema } from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { apiActorOf } from "../actor.js";
import type { PublicApiArea } from "../area.js";

/*
 * The public surface's validate, registered into the `/api/public/v1`
 * plugin (routes.ts), so it runs the token check, the per-token limit and
 * its access check (read) before anything else. It checks a text with the
 * collector validator through the configurations' shared validation service
 * (`validateText`), as the token's user in its organization: the person's
 * validation limits and the organization's variables are the browser's.
 * Nothing is stored. Its OpenAPI fragment is `openapi/validate.yaml`.
 *
 * The text and the collector's errors (which can quote it) go only into the
 * reply's body, never a log line or an error's message; the reply is
 * `no-store`.
 */

/**
 * The body limit, the gateway's on the same path:
 * 262,144 characters of YAML are at most 1.5 MiB once JSON escapes them.
 */
export const VALIDATE_BODY_LIMIT = 2 * 1024 * 1024;

export const registerValidatePublicRoutes: PublicApiArea = (api, { deps }) => {
  const typed = api.withTypeProvider<ZodTypeProvider>();
  const { validation } = deps.services.configurations;

  typed.post(
    "/validate",
    {
      config: { access: "read" },
      bodyLimit: VALIDATE_BODY_LIMIT,
      schema: {
        body: PublicValidateRequestSchema,
        response: {
          200: PublicValidateResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          413: ErrorResponseSchema,
          429: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const answer = await validation.validateText(actor, actor.context.organizationId, request.body);
      return reply.header("cache-control", "no-store").send(answer);
    },
  );
};
