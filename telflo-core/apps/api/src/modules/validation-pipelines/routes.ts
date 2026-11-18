import {
  CreateValidationPipelineRequestSchema,
  CreateValidationRuleRequestSchema,
  ErrorResponseSchema,
  UpdateValidationRuleRequestSchema,
  ValidationPipelineResponseSchema,
  ValidationPipelinesResponseSchema,
  ValidationRuleResponseSchema,
  ValidationRulesResponseSchema,
  type ValidationPipeline as ValidationPipelineResponseBody,
  type ValidationRule as ValidationRuleResponseBody,
} from "@telflo/contracts";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withAuthContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createConfigurationRepository } from "../configurations/repositories/configuration-repository.js";
import { createConfigurationVersionRepository } from "../configurations/repositories/configuration-version-repository.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createMemberRepository } from "../organizations/repositories/member-repository.js";
import { createActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { actorOf } from "../organizations/routes.js";
import { createAuthenticate, requireCurrentTerms } from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import {
  createValidationPipelineRepository,
  type ValidationPipeline,
} from "./repositories/validation-pipeline-repository.js";
import { createValidationRuleRepository, type ValidationRule } from "./repositories/validation-rule-repository.js";
import { createValidationPipelineService } from "./service.js";
import type { WithValidationPipelinesTransaction } from "./transaction.js";

/** What the validation pipelines service is built from, once, in buildServer (D25 decision 15, Preflight ruling 4). */
export interface ValidationPipelineServicesDependencies extends ServerDependencies {
  now: () => Date;
}

/** The validation pipelines service, one instance shared by the browser routes here and the public routes (D25 decision 15). */
export interface ValidationPipelineServices {
  service: ReturnType<typeof createValidationPipelineService>;
}

export interface ValidationPipelinesRoutesDependencies extends ValidationPipelineServicesDependencies {
  /** buildServer's shared instances (createValidationPipelineServices). */
  services: { validationPipelines: ValidationPipelineServices };
}

/**
 * Every answer here carries configuration text (a pipeline's name, a rule's
 * text), so no cache keeps a copy (docs/conventions/security.md).
 */
const NO_STORE = "no-store";

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

/** A pipeline's create: a read's, and 409 for a second on one YAML pipeline. */
const pipelineCreateErrorResponses = { ...errorResponses, 409: ErrorResponseSchema };

/** A rule's save: a read's, 409 past the cap, 429 past the checks' limit, 503 while the evaluator can't check it. */
const ruleSaveErrorResponses = {
  ...errorResponses,
  409: ErrorResponseSchema,
  429: ErrorResponseSchema,
  503: ErrorResponseSchema,
};

/** Any string for every id: one naming nothing the caller can see is the same 404, never a 400 (D5 decision 7). */
const VersionParamsSchema = z.object({ organizationId: z.string(), configurationId: z.string(), versionId: z.string() });
const PipelineParamsSchema = VersionParamsSchema.extend({ validationPipelineId: z.string() });
const RuleParamsSchema = PipelineParamsSchema.extend({ ruleId: z.string() });

const PIPELINES_ROUTE =
  "/api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId/validation-pipelines";
const RULES_ROUTE = `${PIPELINES_ROUTE}/:validationPipelineId/rules`;

/** A pipeline's name goes only into a response body (ADR 0024). */
function toPipelineResponseBody(pipeline: ValidationPipeline): ValidationPipelineResponseBody {
  return {
    id: pipeline.id,
    configurationId: pipeline.configurationId,
    versionId: pipeline.versionId,
    pipeline: pipeline.pipeline,
    signal: pipeline.signal,
    createdByUserId: pipeline.createdByUserId,
    createdAt: pipeline.createdAt.toISOString(),
  };
}

/** A rule's text goes only into a response body (ADR 0024). */
function toRuleResponseBody(rule: ValidationRule): ValidationRuleResponseBody {
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
  };
}

/**
 * The validation pipelines service (D25 Preflight ruling 4), moved verbatim
 * from the routes: built once in buildServer and shared by the browser and
 * the public routes, so its rule checks are counted once per person.
 */
export function createValidationPipelineServices(
  deps: ValidationPipelineServicesDependencies,
  rateLimiters: Pick<RateLimiters, "validationRuleChecksPerUser">,
  log: FastifyBaseLogger,
): ValidationPipelineServices {
  const { db, testing, now } = deps;
  const withTransaction: WithValidationPipelinesTransaction = (context, work) =>
    withAuthContext(db, context, (transaction) => {
      const scope = { organizationId: context.organizationId };
      // The viewer is the database context's user, so the repositories'
      // filters and row-level security see the same rows.
      const viewer = { organizationId: context.organizationId, userId: context.userId };
      return work({
        organization: createActiveOrganizationRepository(transaction, scope),
        members: createMemberRepository(transaction, scope),
        configurations: createConfigurationRepository(transaction, viewer),
        versions: createConfigurationVersionRepository(transaction, viewer),
        pipelines: createValidationPipelineRepository(transaction, viewer),
        rules: createValidationRuleRepository(transaction, viewer),
        audit: createAuditRepository(transaction),
      });
    });
  const service = createValidationPipelineService({
    withTransaction,
    evaluator: testing.ottlEvaluator,
    limiter: rateLimiters.validationRuleChecksPerUser,
    now,
    log,
  });
  return { service };
}

/**
 * The validation pipelines and rules endpoints (D15a details 24 and 25;
 * Preflight rulings 16, 19 and 20). Each needs a session and the current
 * terms; each re-reads the caller's membership under the organization's
 * lock, and each write then locks the configuration (service.ts); each
 * answers 404 for anything the caller can't see, as the suites do. Each
 * transaction carries the request's `AuthContext`, so row-level security
 * on the pipelines and rules admits the same rows the repositories do.
 *
 * A rule's POST and PATCH have the OTTL evaluator check a regex or OTTL rule
 * first (decision 6), outside any transaction, counted against the
 * person's checked saves in the organization (RATE_LIMITS'
 * validationRuleChecksPerUser, decision 16; D14b decision 23).
 *
 * Pipeline names, rules' text and the evaluator's words travel only in the
 * JSON bodies: never in a URL, a log line or an audit row.
 */
export function registerValidationPipelinesRoutes(
  server: FastifyInstance,
  deps: ValidationPipelinesRoutesDependencies,
): void {
  const { service } = deps.services.validationPipelines;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const preHandler = [authenticate, requireCurrentTerms];
  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.get(
    PIPELINES_ROUTE,
    {
      preHandler,
      schema: { params: VersionParamsSchema, response: { 200: ValidationPipelinesResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const pipelines = await service.listPipelines(actorOf(request), request.params);
      return reply.header("cache-control", NO_STORE).send({ validationPipelines: pipelines.map(toPipelineResponseBody) });
    },
  );

  typed.post(
    PIPELINES_ROUTE,
    {
      preHandler,
      schema: {
        params: VersionParamsSchema,
        body: CreateValidationPipelineRequestSchema,
        response: { 201: ValidationPipelineResponseSchema, ...pipelineCreateErrorResponses },
      },
    },
    async (request, reply) => {
      const pipeline = await service.createPipeline(actorOf(request), request.params, request.body);
      return reply
        .status(201)
        .header("cache-control", NO_STORE)
        .send({ validationPipeline: toPipelineResponseBody(pipeline) });
    },
  );

  typed.delete(
    `${PIPELINES_ROUTE}/:validationPipelineId`,
    { preHandler, schema: { params: PipelineParamsSchema, response: { 204: noContent, ...errorResponses } } },
    async (request, reply) => {
      const { validationPipelineId, ...path } = request.params;
      await service.removePipeline(actorOf(request), path, validationPipelineId);
      return reply.status(204).send(null);
    },
  );

  typed.get(
    RULES_ROUTE,
    {
      preHandler,
      schema: { params: PipelineParamsSchema, response: { 200: ValidationRulesResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { validationPipelineId, ...path } = request.params;
      const rules = await service.listRules(actorOf(request), path, validationPipelineId);
      return reply.header("cache-control", NO_STORE).send({ rules: rules.map(toRuleResponseBody) });
    },
  );

  typed.post(
    RULES_ROUTE,
    {
      preHandler,
      schema: {
        params: PipelineParamsSchema,
        body: CreateValidationRuleRequestSchema,
        response: { 201: ValidationRuleResponseSchema, ...ruleSaveErrorResponses },
      },
    },
    async (request, reply) => {
      const { validationPipelineId, ...path } = request.params;
      const rule = await service.createRule(actorOf(request), path, validationPipelineId, request.body);
      return reply.status(201).header("cache-control", NO_STORE).send({ rule: toRuleResponseBody(rule) });
    },
  );

  typed.patch(
    `${RULES_ROUTE}/:ruleId`,
    {
      preHandler,
      schema: {
        params: RuleParamsSchema,
        body: UpdateValidationRuleRequestSchema,
        response: { 200: ValidationRuleResponseSchema, ...ruleSaveErrorResponses },
      },
    },
    async (request, reply) => {
      const { validationPipelineId, ruleId, ...path } = request.params;
      const rule = await service.updateRule(actorOf(request), path, validationPipelineId, ruleId, request.body);
      return reply.header("cache-control", NO_STORE).send({ rule: toRuleResponseBody(rule) });
    },
  );

  typed.delete(
    `${RULES_ROUTE}/:ruleId`,
    { preHandler, schema: { params: RuleParamsSchema, response: { 204: noContent, ...errorResponses } } },
    async (request, reply) => {
      const { validationPipelineId, ruleId, ...path } = request.params;
      await service.removeRule(actorOf(request), path, validationPipelineId, ruleId);
      return reply.status(204).send(null);
    },
  );
}
