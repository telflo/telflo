import {
  CONFIGURATION_INVALID_MESSAGE,
  ErrorResponseSchema,
  PUBLIC_PIPELINE_NOT_IN_CONFIGURATION_MESSAGE,
  PUBLIC_PIPELINE_SIGNAL_MISMATCH_MESSAGE,
  PublicReplacedValidationRulesSchema,
  PublicReplaceValidationRulesRequestSchema,
  PublicValidationPipelineNameSchema,
  PublicValidationPipelinesSchema,
  PublicVersionNumberSchema,
  signalOfPipeline,
  type ConfigurationErrorCode,
  type PublicValidationPipeline,
  type PublicValidationRule,
} from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError } from "../../../errors.js";
import type { ValidationPipeline } from "../../validation-pipelines/repositories/validation-pipeline-repository.js";
import type { ValidationRule } from "../../validation-pipelines/repositories/validation-rule-repository.js";
import { apiActorOf } from "../actor.js";
import type { PublicApiArea } from "../area.js";
import { hasPipelineKey } from "../yaml-pipelines.js";

/*
 * The public surface's validation pipelines of a configuration's version,
 * registered into the `/api/public/v1` plugin (routes.ts), so each runs the
 * token check, the per-token limit and its access check first. Both go
 * through the shared validation pipelines service as the token's user in
 * its organization (`apiActorOf`): a version's pipelines follow its
 * configuration's visibility, so another member's draft's, another
 * organization's and a malformed id's are the configurations' 404s. The
 * version is named by its number (`versionIdOf`). Its OpenAPI fragment is
 * `openapi/validation-pipelines.yaml`.
 *
 * The PUT's pipeline is a collector pipeline's name, which holds `/`
 * (`traces/otlp`): the route is a wildcard after `/validation-pipelines/`,
 * its value Fastify's one decoding of the path (`%2F` is `/`; `%252F` stays
 * `%2F`), never decoded again here. Its checks, in order: 1 to 200
 * characters (400, the params' schema); the body's signal its first part
 * (400 `invalid_request`: the request contradicts itself, which needs no
 * stored state, as the Validation tab's OTTL context check is 400); the
 * version visible (404); a key of the version's `service.pipelines` (422
 * `configuration_invalid`, its one error at `service.pipelines`, in fixed
 * words). Then the service checks and writes the rules.
 *
 * A pipeline's name, a rule's text and the evaluator's words go only into a
 * reply's body (`no-store`), never a log line, an error's message or an
 * audit row.
 */

const NO_STORE = "no-store";

/** Any string: the service answers one that isn't a canonical UUID with the configurations' 404. */
const VersionParamsSchema = z.object({ configurationId: z.string(), versionNumber: PublicVersionNumberSchema });

/** And the pipeline, Fastify's wildcard (`*`), decoded once by the router. */
const PipelineParamsSchema = VersionParamsSchema.extend({ "*": PublicValidationPipelineNameSchema });

/** Every route's refusals: the token's 401, a personal token's organization (400, 403), the 404s and the per-token limit. */
const readErrorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  429: ErrorResponseSchema,
};

/** The PUT's: a read token's 403, a body over 1 MiB, the cap's 409, a name the text lacks (422), and the evaluator down (503). */
const putErrorResponses = {
  ...readErrorResponses,
  409: ErrorResponseSchema,
  413: ErrorResponseSchema,
  422: ErrorResponseSchema,
  503: ErrorResponseSchema,
};

/** The body's signal isn't the pipeline name's first part: 400 `invalid_request`, its issue at `signal`. */
function signalMismatch(): AppError {
  return new AppError("invalid_request", "The request was not valid.", 400, [
    { path: ["signal"], message: PUBLIC_PIPELINE_SIGNAL_MISMATCH_MESSAGE },
  ]);
}

/** The pipeline isn't a key of the version's `service.pipelines`: 422, in fixed words, never a name. */
function pipelineNotInConfiguration(): AppError {
  return new AppError("configuration_invalid" satisfies ConfigurationErrorCode, CONFIGURATION_INVALID_MESSAGE, 422, {
    errors: [{ message: PUBLIC_PIPELINE_NOT_IN_CONFIGURATION_MESSAGE, componentPath: "service.pipelines" }],
  });
}

function toPublicRule(rule: ValidationRule): PublicValidationRule {
  return {
    id: rule.id,
    validationPipelineId: rule.validationPipelineId,
    position: rule.position,
    kind: rule.kind,
    target: rule.target,
    pattern: rule.pattern,
    ottl: rule.ottl,
    name: rule.name,
    description: rule.description,
    createdByUserId: rule.createdByUserId,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    isApiOwned: rule.isApiOwned,
  };
}

function toPublicPipeline(
  pipeline: ValidationPipeline & { rules: ValidationRule[] },
  versionNumber: number,
): PublicValidationPipeline {
  return {
    id: pipeline.id,
    configurationId: pipeline.configurationId,
    versionId: pipeline.versionId,
    versionNumber,
    pipeline: pipeline.pipeline,
    signal: pipeline.signal,
    createdByUserId: pipeline.createdByUserId,
    createdAt: pipeline.createdAt.toISOString(),
    rules: pipeline.rules.map(toPublicRule),
  };
}

export const registerValidationPipelinePublicRoutes: PublicApiArea = (api, { deps }) => {
  const { service: configurations } = deps.services.configurations;
  const { service } = deps.services.validationPipelines;
  const typed = api.withTypeProvider<ZodTypeProvider>();

  // Every validation pipeline the caller can see on the version, oldest
  // first, each with its rules in position order; one page.
  typed.get(
    "/configurations/:configurationId/versions/:versionNumber/validation-pipelines",
    {
      config: { access: "read" },
      schema: {
        params: VersionParamsSchema,
        response: { 200: PublicValidationPipelinesSchema, ...readErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      const { configurationId, versionNumber } = request.params;
      const versionId = await configurations.versionIdOf(actor, organizationId, configurationId, versionNumber);
      const pipelines = await service.listPipelinesWithRules(actor, { organizationId, configurationId, versionId });
      return reply
        .header("cache-control", NO_STORE)
        .send({ items: pipelines.map((pipeline) => toPublicPipeline(pipeline, versionNumber)), nextCursor: null });
    },
  );

  // The rules the public API owns on the version's pipeline for the name
  // in the path, replaced; a person's kept. Allowed on a published version,
  // as the Validation tab's saves are. The global 1 MiB body limit: 20 rules
  // at their maxima are about 500 KB of UTF-8 as sent. JSON's escapes grow
  // them: a text or regex rule whose pattern, name and description are all
  // astral characters escaped as `\uXXXX\uXXXX` (Python's json default) is
  // about 50 KB, so 20 come to about 0.95 MiB; a distinct rule's two texts
  // so escaped, or control characters, pass 1 MiB: a clean 413
  // `payload_too_large`, nothing read.
  typed.put(
    "/configurations/:configurationId/versions/:versionNumber/validation-pipelines/*",
    {
      config: { access: "write" },
      schema: {
        params: PipelineParamsSchema,
        body: PublicReplaceValidationRulesRequestSchema,
        response: { 200: PublicReplacedValidationRulesSchema, ...putErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      const { configurationId, versionNumber, "*": pipeline } = request.params;
      const { signal, rules } = request.body;
      if (signalOfPipeline(pipeline) !== signal) throw signalMismatch();
      const versionId = await configurations.versionIdOf(actor, organizationId, configurationId, versionNumber);
      const { version } = await configurations.getVersion(actor, organizationId, configurationId, versionId);
      if (!hasPipelineKey(version.yamlContent, pipeline)) throw pipelineNotInConfiguration();
      const replaced = await service.replaceApiOwnedRules(actor, { organizationId, configurationId, versionId }, pipeline, rules);
      return reply.header("cache-control", NO_STORE).send({
        ...toPublicPipeline(replaced, versionNumber),
        created: replaced.created,
        rulesReplaced: replaced.rulesReplaced,
        rulesKept: replaced.rulesKept,
      });
    },
  );
};
