import {
  ConfigurationResponseSchema,
  ConfigurationsPageSchema,
  ConfigurationValidationResponseSchema,
  ConfigurationVersionResponseSchema,
  ConfigurationVersionsQuerySchema,
  ConfigurationVersionsResponseSchema,
  ConfigurationVersionSummaryResponseSchema,
  ConfigurationWithVersionResponseSchema,
  CreateConfigurationRequestSchema,
  CreateConfigurationVersionRequestSchema,
  ErrorResponseSchema,
  ListConfigurationsQuerySchema,
  PublishConfigurationVersionRequestSchema,
  RenameConfigurationVersionRequestSchema,
  SaveConfigurationVersionRequestSchema,
  SelectConfigurationVersionRequestSchema,
  UpdateConfigurationRequestSchema,
  ValidateConfigurationVersionRequestSchema,
  type Configuration as ConfigurationResponseBody,
  type ConfigurationVersion as ConfigurationVersionResponseBody,
  type ConfigurationVersionListItem as ConfigurationVersionListItemBody,
  type ConfigurationVersionSummary as ConfigurationVersionSummaryResponseBody,
  type ConfigurationWithVersionResponse,
} from "@telflo/contracts";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withAuthContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import type { RunAfterResponse } from "../../http/after-response.js";
import type { FleetLimiter, RateLimiters } from "../../http/rate-limits.js";
import type { OpampServerClient } from "../../opamp-server/client.js";
import { createCollectorCatalogueRepository } from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createMemberRepository } from "../organizations/repositories/member-repository.js";
import { createActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { actorOf } from "../organizations/routes.js";
import { createAuthenticate, requireCurrentTerms } from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { opampOrganizationVariables } from "../test-runs/organization-variables.js";
import { createTestSuiteRepository } from "../test-suites/repositories/test-suite-repository.js";
import { createValidationPipelineRepository } from "../validation-pipelines/repositories/validation-pipeline-repository.js";
import { createConfigurationRepository, type Configuration } from "./repositories/configuration-repository.js";
import { invalidGraph } from "./errors.js";
import {
  createConfigurationVersionRepository,
  isStoredGraphCheckViolation,
  type ConfigurationVersion,
  type ConfigurationVersionSummary,
} from "./repositories/configuration-version-repository.js";
import { createConfigurationVersionSelectionRepository } from "./repositories/configuration-version-selection-repository.js";
import { createPublicationsCleanup, createPublishingService } from "./publishing.js";
import {
  createConfigurationService,
  type ConfigurationServiceDependencies,
  type ConfigurationWithVersion,
  type CreateConfigurationInput,
  type WithConfigurationTransaction,
} from "./service.js";
import { createValidationService } from "./validation.js";

/** What the configurations' services are built from, once, in buildServer (D25 decision 15, Preflight ruling 4). */
export interface ConfigurationServicesDependencies extends ServerDependencies {
  now: () => Date;
  /** buildServer's runner: a delete's clean-up runs on it (D11b decision 12). */
  runAfterResponse: RunAfterResponse;
}

/**
 * The configurations' services, one instance each, shared by the browser
 * routes here and the public routes (D25 decision 15): configurations,
 * D11b's publishing and D13b's validation, with one validation limiter.
 */
export interface ConfigurationServices {
  service: ReturnType<typeof createConfigurationService>;
  publishing: ReturnType<typeof createPublishingService>;
  validation: ReturnType<typeof createValidationService>;
}

export interface ConfigurationRoutesDependencies extends ConfigurationServicesDependencies {
  /** buildServer's shared instances (createConfigurationServices). */
  services: { configurations: ConfigurationServices };
}

/**
 * The list's path. Its query holds the search text, usually a
 * configuration's name, so the request log drops it (Preflight ruling 4):
 * `http/request-log.ts` names this path too.
 */
const CONFIGURATIONS_LIST_ROUTE = "/api/v1/organizations/:organizationId/configurations";

/**
 * A version's save allows 5 MiB, five times the server's 1 MiB (D9a decision
 * 6): 262,144 characters of YAML, up to 1.5 MiB once JSON escapes them
 * (D8 decision 7), and the graph's three columns, at most 1 MiB of JSON each
 * (about 4.4 MiB in all). A version's create carries the same content, and
 * gets the same (D10 decision 4), and so does a configuration's create,
 * which may carry a flow's (D12 Preflight ruling 7): its name, description
 * and slug add under 1 KiB. The gateway allows the same on the three paths
 * (`docker/gateway/default.conf`).
 */
const VERSION_CONTENT_BODY_LIMIT = 5 * 1024 * 1024;

/**
 * A validation's body (D13b decision 12): the text, 262,144 characters, up
 * to 1.5 MiB once JSON escapes them, as a save's (D8 decision 7), with
 * nothing else of size. The gateway allows the same on its path.
 */
const VALIDATION_BODY_LIMIT = 2 * 1024 * 1024;

// The four routes with these limits (the create, a version's save and
// create, and a validation) check the session in `onRequest`, before
// Fastify reads the body (D36-1 decision 42, Preflight ruling 9): a request
// without a valid session is 401 whatever its body, never 413 (only the
// server-wide CSRF guard runs before it). The Terms check stays in
// `preHandler`.

/**
 * The responses that carry a configuration's YAML, which can hold secrets,
 * tell every cache to keep no copy (D8; D10 decision 4;
 * docs/conventions/security.md): both reads, the save and the create.
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

/** A write to a version, which a published one refuses (D11b decision 4): the save and the rename. */
const versionWriteErrorResponses = { ...errorResponses, 409: ErrorResponseSchema };

/** A publish's refusals: a version's write's, and 503 when the opamp-server can't take it (D11b decision 11). */
const publishErrorResponses = { ...versionWriteErrorResponses, 503: ErrorResponseSchema };

/**
 * A validation's refusals: a read's, 429 for the person's limits and 503 when
 * the validator can't check (D13b decision 12) or the organization's variables
 * can't be read (D20 decision 27).
 */
const validationErrorResponses = { ...errorResponses, 429: ErrorResponseSchema, 503: ErrorResponseSchema };

/**
 * A delete's refusals (D16b decision 19, Preflight ruling 6): a read's, 409
 * when a fleet uses a published version, 429 for the person's fleet limit
 * and 503 when the opamp-server can't say.
 */
const deleteErrorResponses = { ...errorResponses, 409: ErrorResponseSchema, 429: ErrorResponseSchema, 503: ErrorResponseSchema };

/** Any string: a path naming anything but the active organization is the same 404 (D5 decision 7), not a 400. */
const OrganizationParamsSchema = z.object({ organizationId: z.string() });

/** Any string for the configuration too: the service answers one that isn't a UUID with 404 configuration_not_found. */
const ConfigurationParamsSchema = z.object({ organizationId: z.string(), configurationId: z.string() });

/**
 * And for the version: a malformed one is 404 configuration_not_found for the
 * save (D8 decision 4), and configuration_version_not_found for the read,
 * the rename (D10 decision 4) and the publish (D11b Preflight ruling 15).
 */
const ConfigurationVersionParamsSchema = z.object({
  organizationId: z.string(),
  configurationId: z.string(),
  versionId: z.string(),
});

function toResponseBody(configuration: Configuration): ConfigurationResponseBody {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    createdAt: configuration.createdAt.toISOString(),
    updatedAt: configuration.updatedAt.toISOString(),
    createdBy:
      configuration.createdBy === null
        ? null
        : { userId: configuration.createdBy.userId, email: configuration.createdBy.email },
    published: configuration.published,
    collectorDistribution: configuration.collectorDistribution,
  };
}

/**
 * The YAML and the graph go only into a response body, never into a log line
 * or an audit row (D8 Global constraints; D9a decision 6).
 */
function toVersionResponseBody(version: ConfigurationVersion): ConfigurationVersionResponseBody {
  return {
    ...toVersionSummaryResponseBody(version),
    configurationId: version.configurationId,
    yamlContent: version.yamlContent,
    nodes: version.nodes,
    edges: version.edges,
    pipelines: version.pipelines,
  };
}

/**
 * A version as the picker lists it (D10 decision 4): no content. The label
 * and the creator's email go only into a response body (ADR 0024).
 */
function toVersionSummaryResponseBody(version: ConfigurationVersionSummary): ConfigurationVersionSummaryResponseBody {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    label: version.label,
    createdBy:
      version.createdBy === null ? null : { userId: version.createdBy.userId, email: version.createdBy.email },
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
    publishedAt: version.publishedAt === null ? null : version.publishedAt.toISOString(),
    // The publisher's email, as the creator's, goes only into a response body (ADR 0024).
    publishedBy:
      version.publishedBy === null ? null : { userId: version.publishedBy.userId, email: version.publishedBy.email },
    // The pin and whether the catalogue deprecated it since (D13a decisions
    // 4 and 8). The distribution is the configuration's, which carries it.
    collectorVersion: version.collectorVersion,
    collectorVersionDeprecated: version.collectorVersionDeprecated,
    collectorVersionDeprecatedNote: version.collectorVersionDeprecatedNote,
  };
}

/**
 * A version as the versions route lists it (D17b-1 decision 31, the owner's
 * Q17): its id, number, label and published date only, never a member's
 * email, its times or its collector version.
 */
function toVersionListItemBody(version: ConfigurationVersionSummary): ConfigurationVersionListItemBody {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    label: version.label,
    publishedAt: version.publishedAt === null ? null : version.publishedAt.toISOString(),
  };
}

/** Both reads' answer (D10 decision 4): the configuration, the version, and every version's summary. */
function toWithVersionResponseBody({
  configuration,
  version,
  versions,
}: ConfigurationWithVersion): ConfigurationWithVersionResponse {
  return {
    configuration: toResponseBody(configuration),
    version: toVersionResponseBody(version),
    versions: versions.map(toVersionSummaryResponseBody),
  };
}

/**
 * A create's body as the service takes it: the content's four fields as one
 * (the contract lets them come only together, D12 Preflight ruling 7), each
 * other field only when given.
 */
function createInputOf(body: z.infer<typeof CreateConfigurationRequestSchema>): CreateConfigurationInput {
  const { yamlContent, nodes, edges, pipelines, collectorDistribution, collectorVersion, sourceFlowSlug } = body;
  return {
    name: body.name,
    description: body.description,
    ...(collectorDistribution !== undefined && { collectorDistribution }),
    ...(yamlContent !== undefined &&
      nodes !== undefined &&
      edges !== undefined &&
      pipelines !== undefined && { content: { yamlContent, nodes, edges, pipelines } }),
    ...(collectorVersion !== undefined && { collectorVersion }),
    ...(sourceFlowSlug !== undefined && { sourceFlowSlug }),
  };
}

/**
 * A content write's graph within the contract that the table's backstop
 * still refuses (D9a Preflight ruling 3): the request's fault, so 400, and
 * the database's error, whose detail holds the row, goes nowhere.
 */
async function refusingStoredGraphViolations<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (isStoredGraphCheckViolation(error)) throw invalidGraph();
    throw error;
  }
}

/**
 * D16b decision 19, Preflight rulings 6 and 12: a delete's question to the
 * opamp-server, one read and one in-flight slot of the person's fleet
 * limits in the organization, the slot given back whatever the call does.
 */
function createFleetUsage(opampServer: OpampServerClient, limiter: FleetLimiter): ConfigurationServiceDependencies["fleetUsage"] {
  return async (context, configurationId) => {
    const admission = limiter.admit(context.userId, context.organizationId, "read");
    if (!admission.isAdmitted) return { kind: "rate_limited", retryAfterSeconds: admission.retryAfterSeconds };
    try {
      return await opampServer.getConfigurationUsage(context.organizationId, configurationId);
    } finally {
      admission.release();
    }
  };
}

/**
 * The configurations' services (D25 Preflight ruling 4), moved verbatim from
 * the routes: built once in buildServer and shared by the browser and the
 * public routes. Each transaction carries the actor's context (a session's
 * or a token's) as its database context.
 */
export function createConfigurationServices(
  deps: ConfigurationServicesDependencies,
  rateLimiters: Pick<RateLimiters, "validationsPerUser" | "fleetsPerUser">,
  log: FastifyBaseLogger,
): ConfigurationServices {
  const { db, now, opampServer, otelcolValidator, runAfterResponse } = deps;
  const withTransaction: WithConfigurationTransaction = (context, work) =>
    withAuthContext(db, context, (transaction) => {
      const scope = { organizationId: context.organizationId };
      // The viewer is the database context's user, so the repositories'
      // filters and row-level security see the same drafts.
      const viewer = { organizationId: context.organizationId, userId: context.userId };
      return work({
        organization: createActiveOrganizationRepository(transaction, scope),
        members: createMemberRepository(transaction, scope),
        configurations: createConfigurationRepository(transaction, viewer),
        versions: createConfigurationVersionRepository(transaction, viewer),
        selections: createConfigurationVersionSelectionRepository(transaction, scope),
        suites: createTestSuiteRepository(transaction, viewer),
        validationPipelines: createValidationPipelineRepository(transaction, viewer),
        catalogue: createCollectorCatalogueRepository(transaction),
        audit: createAuditRepository(transaction),
      });
    });
  const service = createConfigurationService({
    withTransaction,
    now,
    afterDelete: createPublicationsCleanup({ opampServer, runAfterResponse, log }),
    fleetUsage: createFleetUsage(opampServer, rateLimiters.fleetsPerUser),
    log,
  });
  const publishing = createPublishingService({ withTransaction, now, opampServer, runAfterResponse, log });
  const validation = createValidationService({
    withTransaction,
    validator: otelcolValidator,
    variables: opampOrganizationVariables(opampServer),
    limiter: rateLimiters.validationsPerUser,
    log,
    // Global, so read outside any organization's transaction (D25 Ruling 168: validateText's distribution check).
    catalogue: createCollectorCatalogueRepository(db),
  });
  return { service, publishing, validation };
}

/**
 * D7 decision 5's four endpoints, D8 decision 4's read of one configuration
 * and save of its version, D10 decision 4's read of one version, create,
 * rename and selection, D11b decision 11's publish, D13b decision 12's
 * validation, and D17b-1 decision 31's list of a configuration's versions.
 * Each needs a session and the current terms (decision 10), and
 * none is rate limited (D2c decision 7) but two: the validation, which the
 * validation service limits per person after its read (D13b decision 12,
 * Ruling 37), and a published configuration's delete, whose fleet usage
 * check spends the person's fleet limits after its read (D16b decision 19,
 * Preflight rulings 6 and 12). Each transaction carries the request's context as its
 * database context, so row-level security on `configurations`,
 * `configuration_versions` and `configuration_version_selections` admits
 * only the active organization's rows, and of those only the caller's
 * drafts and the published ones (D11b decision 1). The repositories are the caller's view by the same rule.
 *
 * The validator/serializer compilers are server-wide and set once in
 * buildServer, not here.
 */
export function registerConfigurationRoutes(server: FastifyInstance, deps: ConfigurationRoutesDependencies): void {
  const { service, publishing, validation } = deps.services.configurations;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const preHandler = [authenticate, requireCurrentTerms];
  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.get(
    CONFIGURATIONS_LIST_ROUTE,
    {
      preHandler,
      schema: {
        params: OrganizationParamsSchema,
        querystring: ListConfigurationsQuerySchema,
        response: { 200: ConfigurationsPageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { limit, cursor, q, filter } = request.query;
      const page = await service.list(actorOf(request), request.params.organizationId, {
        limit,
        cursor,
        search: q,
        filter,
      });
      return reply.send({ items: page.items.map(toResponseBody), nextCursor: page.nextCursor });
    },
  );

  // D7 decision 5's create, which D12 decision 12 lets carry a flow's
  // content, collector version and slug (Preflight ruling 7): the version
  // routes' body limit, and the save's answer to a graph the table's
  // backstop refuses. The answer is the configuration alone, without the
  // slug (Preflight ruling 9) or the content.
  typed.post(
    CONFIGURATIONS_LIST_ROUTE,
    {
      onRequest: authenticate,
      preHandler: requireCurrentTerms,
      bodyLimit: VERSION_CONTENT_BODY_LIMIT,
      schema: {
        params: OrganizationParamsSchema,
        body: CreateConfigurationRequestSchema,
        response: { 201: ConfigurationResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const configuration = await refusingStoredGraphViolations(() =>
        service.create(actorOf(request), request.params.organizationId, createInputOf(request.body)),
      );
      return reply.status(201).send({ configuration: toResponseBody(configuration) });
    },
  );

  typed.get(
    "/api/v1/organizations/:organizationId/configurations/:configurationId",
    {
      preHandler,
      schema: {
        params: ConfigurationParamsSchema,
        response: { 200: ConfigurationWithVersionResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, configurationId } = request.params;
      const found = await service.get(actorOf(request), organizationId, configurationId);
      return reply.header("cache-control", NO_STORE).send(toWithVersionResponseBody(found));
    },
  );

  typed.patch(
    "/api/v1/organizations/:organizationId/configurations/:configurationId",
    {
      preHandler,
      schema: {
        params: ConfigurationParamsSchema,
        body: UpdateConfigurationRequestSchema,
        response: { 200: ConfigurationResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, configurationId } = request.params;
      const configuration = await service.update(actorOf(request), organizationId, configurationId, request.body);
      return reply.send({ configuration: toResponseBody(configuration) });
    },
  );

  typed.delete(
    "/api/v1/organizations/:organizationId/configurations/:configurationId",
    {
      preHandler,
      schema: { params: ConfigurationParamsSchema, response: { 204: noContent, ...deleteErrorResponses } },
    },
    async (request, reply) => {
      await service.remove(actorOf(request), request.params.organizationId, request.params.configurationId);
      return reply.status(204).send(null);
    },
  );

  typed.patch(
    "/api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId",
    {
      onRequest: authenticate,
      preHandler: requireCurrentTerms,
      bodyLimit: VERSION_CONTENT_BODY_LIMIT,
      schema: {
        params: ConfigurationVersionParamsSchema,
        body: SaveConfigurationVersionRequestSchema,
        response: { 200: ConfigurationVersionResponseSchema, ...versionWriteErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, configurationId, versionId } = request.params;
      const version = await refusingStoredGraphViolations(() =>
        service.saveVersion(actorOf(request), organizationId, configurationId, versionId, request.body),
      );
      return reply.header("cache-control", NO_STORE).send({ version: toVersionResponseBody(version) });
    },
  );

  typed.get(
    "/api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId",
    {
      preHandler,
      schema: {
        params: ConfigurationVersionParamsSchema,
        response: { 200: ConfigurationWithVersionResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, configurationId, versionId } = request.params;
      const found = await service.getVersion(actorOf(request), organizationId, configurationId, versionId);
      return reply.header("cache-control", NO_STORE).send(toWithVersionResponseBody(found));
    },
  );

  // D17b-1 decisions 7 and 31 (the owner's Q17): the pickers' read of a
  // configuration's versions, with the configuration's read's visibility and
  // refusals: each version's id, number, label and published date only. No
  // YAML or layout, so cacheable, as the list.
  typed.get(
    "/api/v1/organizations/:organizationId/configurations/:configurationId/versions",
    {
      preHandler,
      schema: {
        params: ConfigurationParamsSchema,
        querystring: ConfigurationVersionsQuerySchema,
        response: { 200: ConfigurationVersionsResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, configurationId } = request.params;
      const versions = await service.listVersions(actorOf(request), organizationId, configurationId, request.query.filter);
      return reply.send({ versions: versions.map(toVersionListItemBody) });
    },
  );

  typed.post(
    "/api/v1/organizations/:organizationId/configurations/:configurationId/versions",
    {
      onRequest: authenticate,
      preHandler: requireCurrentTerms,
      bodyLimit: VERSION_CONTENT_BODY_LIMIT,
      schema: {
        params: ConfigurationParamsSchema,
        body: CreateConfigurationVersionRequestSchema,
        response: { 201: ConfigurationVersionResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, configurationId } = request.params;
      const version = await refusingStoredGraphViolations(() =>
        service.createVersion(actorOf(request), organizationId, configurationId, request.body),
      );
      return reply.status(201).header("cache-control", NO_STORE).send({ version: toVersionResponseBody(version) });
    },
  );

  typed.put(
    "/api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId/label",
    {
      preHandler,
      schema: {
        params: ConfigurationVersionParamsSchema,
        body: RenameConfigurationVersionRequestSchema,
        response: { 200: ConfigurationVersionSummaryResponseSchema, ...versionWriteErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, configurationId, versionId } = request.params;
      const version = await service.renameVersion(
        actorOf(request),
        organizationId,
        configurationId,
        versionId,
        request.body.label,
      );
      return reply.send({ version: toVersionSummaryResponseBody(version) });
    },
  );

  // D11b decision 11 (Ruling 23's path). The body is optional (Ruling 30):
  // none at all (no content type, as D25's public API may send it; Fastify
  // hands the validator null, so a JSON `null` is the same), or the
  // contract's JSON, whose `expectedUpdatedAt` the editor sends so a save
  // its tab didn't see is refused. A body that isn't the contract's is 400
  // as every other route's: invalid JSON, an unknown field, a timestamp
  // that isn't a summary's, or a JSON content type with an empty body
  // (Fastify's own refusal). The answer is the version's summary, now
  // published, as a rename's is. The YAML goes only to the opamp-server, so
  // nothing here needs `no-store`.
  typed.post(
    "/api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId/publish",
    {
      preHandler,
      schema: {
        params: ConfigurationVersionParamsSchema,
        body: PublishConfigurationVersionRequestSchema.nullable(),
        response: { 200: ConfigurationVersionSummaryResponseSchema, ...publishErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, configurationId, versionId } = request.params;
      const expected = request.body?.expectedUpdatedAt;
      const version = await publishing.publishVersion(
        actorOf(request),
        organizationId,
        configurationId,
        versionId,
        expected === undefined ? {} : { expectedUpdatedAt: new Date(expected) },
      );
      return reply.send({ version: toVersionSummaryResponseBody(version) });
    },
  );

  // D13b decision 12 (Preflight ruling 17's path): the text the editor holds,
  // checked with the configuration's distribution at the version's saved
  // pin, or the tab's unsaved pick. Nothing is stored. The answer carries
  // the collector's messages, which can echo the text's values, so no cache
  // keeps a copy.
  typed.post(
    "/api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId/validation",
    {
      onRequest: authenticate,
      preHandler: requireCurrentTerms,
      bodyLimit: VALIDATION_BODY_LIMIT,
      schema: {
        params: ConfigurationVersionParamsSchema,
        body: ValidateConfigurationVersionRequestSchema,
        response: { 200: ConfigurationValidationResponseSchema, ...validationErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, configurationId, versionId } = request.params;
      const answer = await validation.validateVersion(
        actorOf(request),
        organizationId,
        configurationId,
        versionId,
        request.body,
      );
      return reply.header("cache-control", NO_STORE).send(answer);
    },
  );

  typed.put(
    "/api/v1/organizations/:organizationId/configurations/:configurationId/selected-version",
    {
      preHandler,
      schema: {
        params: ConfigurationParamsSchema,
        body: SelectConfigurationVersionRequestSchema,
        response: { 204: noContent, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, configurationId } = request.params;
      await service.selectVersion(actorOf(request), organizationId, configurationId, request.body.versionId);
      return reply.status(204).send(null);
    },
  );
}
